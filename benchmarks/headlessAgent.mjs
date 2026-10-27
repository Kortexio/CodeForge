/**
 * Headless agent runner for benchmarks.
 * Loads the compiled extension, mocks vscode with disk FS, calls runAgentWithTools.
 *
 * Usage (usually via bench.mjs run):
 *   node benchmarks/headlessAgent.mjs --workspace <dir> --task <text> [--label x] [--server id] [--model id] [--weak on|off]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { resolveBenchLayout } from './layout.mjs';

const LAYOUT = resolveBenchLayout();
const HERE = LAYOUT.here;
const REPO = LAYOUT.repoRoot;
const EXT_OUT = process.env.CODEFORGE_EXT_OUT?.trim() || LAYOUT.extOut;
const VSCODE_MOCK = LAYOUT.vscodeMock;
const SETTINGS_FILE = path.join(os.homedir(), '.CodeForge', 'ai', 'settings.json');

function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith('--')) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		}
	}
	return flags;
}

function die(msg, code = 2) {
	console.error(`NotRun: ${msg}`);
	process.exit(code);
}

function loadActiveLlm(flags) {
	if (!fs.existsSync(SETTINGS_FILE)) {
		die(`settings file missing: ${SETTINGS_FILE}`);
	}
	const state = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	const serverId = flags.server || state.activeServerId;
	const server = (state.servers || []).find(s => s.id === serverId && s.enabled !== false);
	if (!server?.baseUrl?.trim()) {
		die(`no usable active server (id=${serverId || 'none'})`);
	}
	const model =
		flags.model ||
		(state.activeServerId === server.id ? state.activeModel : null) ||
		server.models?.[0];
	if (!model) die(`no model selected on server ${server.name}`);
	return {
		provider: server.kind || 'openai',
		apiKey: server.apiKey || '',
		baseUrl: server.baseUrl.replace(/\/$/, ''),
		model,
		numCtx: server.numCtx && server.numCtx > 0 ? server.numCtx : 32768,
		forceJson: server.forceJson === true,
		serverName: server.name,
		serverId: server.id,
		sampling: server.sampling,
	};
}

function installVscodeMock(workspaceRoot, config) {
	const absMock = path.resolve(VSCODE_MOCK);
	const original = Module._resolveFilename;
	Module._resolveFilename = function (request, parent, isMain, options) {
		if (request === 'vscode') return absMock;
		return original.call(this, request, parent, isMain, options);
	};
	const require = createRequire(import.meta.url);
	const vscode = require(absMock);
	vscode.__setWorkspace(workspaceRoot);
	vscode.__setConfig(config);
	vscode.__setDiagnostics(new Map());
	return vscode;
}

function fakeExtensionContext(home) {
	const store = new Map();
	return {
		subscriptions: [],
		workspaceState: {
			get: (k, d) => (store.has(`ws:${k}`) ? store.get(`ws:${k}`) : d),
			update: async (k, v) => {
				store.set(`ws:${k}`, v);
			},
			keys: () => [...store.keys()].filter(k => k.startsWith('ws:')).map(k => k.slice(3)),
		},
		globalState: {
			get: (k, d) => (store.has(`g:${k}`) ? store.get(`g:${k}`) : d),
			update: async (k, v) => {
				store.set(`g:${k}`, v);
			},
			keys: () => [...store.keys()].filter(k => k.startsWith('g:')).map(k => k.slice(2)),
			setKeysForSync: () => undefined,
		},
		extensionUri: { fsPath: EXT_OUT },
		extensionPath: EXT_OUT,
		storageUri: undefined,
		globalStorageUri: { fsPath: home },
		logUri: { fsPath: home },
		storagePath: undefined,
		globalStoragePath: home,
		logPath: home,
		extensionMode: 3,
		secrets: {
			get: async () => undefined,
			store: async () => undefined,
			delete: async () => undefined,
			onDidChange: () => ({ dispose() {} }),
		},
		environmentVariableCollection: {},
		extension: {},
		asAbsolutePath: p => path.join(EXT_OUT, p),
		languageModelAccessInformation: {},
	};
}

async function probeToolCallMode(llm) {
	try {
		const res = await fetch(`${llm.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: llm.model,
				temperature: 0,
				max_tokens: 128,
				tools: [
					{
						type: 'function',
						function: {
							name: 'ping',
							description: 'Return pong',
							parameters: {
								type: 'object',
								properties: { msg: { type: 'string' } },
								required: ['msg'],
							},
						},
					},
				],
				tool_choice: 'auto',
				messages: [
					{ role: 'system', content: 'Call the ping tool with msg=pong.' },
					{ role: 'user', content: 'ping' },
				],
			}),
		});
		if (!res.ok) return { toolCallMode: 'none', detail: `HTTP ${res.status}` };
		const data = await res.json();
		const msg = data.choices?.[0]?.message;
		if (msg?.tool_calls?.length) return { toolCallMode: 'native' };
		const content = String(msg?.content || '');
		if (/<tool_call>|"tool_calls"|<function\s*=/i.test(content)) {
			return { toolCallMode: 'content' };
		}
		return { toolCallMode: 'none', detail: content.slice(0, 200) };
	} catch (err) {
		return { toolCallMode: 'none', detail: err instanceof Error ? err.message : String(err) };
	}
}

async function resolveNumCtx(llm) {
	const require = createRequire(import.meta.url);
	const { refreshLlamaSlots, effectiveContextBudget, cachedLlamaSlots } = require(
		path.join(EXT_OUT, 'agent', 'llamaSlots.js')
	);
	try {
		await refreshLlamaSlots({
			serverId: llm.serverId,
			model: llm.model,
			baseUrl: llm.baseUrl,
			apiKey: llm.apiKey,
			configuredCtx: llm.numCtx,
		});
	} catch {
		/* probe is best-effort */
	}
	const caps = cachedLlamaSlots(llm.serverId, llm.model);
	const probed = effectiveContextBudget(llm.numCtx, caps) ?? llm.numCtx;
	const hard = Number(process.env.CODEFORGE_BENCH_NUM_CTX);
	const cap = Number.isFinite(hard) && hard >= 2048 ? Math.floor(hard) : 0;
	const numCtx = cap > 0 ? Math.min(probed, cap) : probed;
	if (numCtx < llm.numCtx) {
		console.log(
			`numCtx ${llm.numCtx} clamped to ${numCtx} (server slot / bench cap) so the request cannot grow the KV cache`
		);
	}
	return numCtx;
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));
	const workspace = flags.workspace;
	const task = flags.task;
	if (!workspace || !task) die('need --workspace and --task');
	if (!fs.existsSync(path.join(EXT_OUT, 'agent', 'agentLoop.js'))) {
		die('extension not compiled — run: npm run build:extensions');
	}

	const llm = loadActiveLlm(flags);
	let sampling = llm.sampling;
	if (flags.sampling) {
		try {
			sampling = {
				...(sampling || {}),
				...JSON.parse(String(flags.sampling)),
			};
		} catch (err) {
			die(`invalid --sampling JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const weak = String(flags.weak ?? 'on') !== 'off';
	const numCtx = await resolveNumCtx(llm);
	const runHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-bench-home-'));
	process.env.CODEFORGE_HOME = runHome;

	const vscode = installVscodeMock(workspace, {
		'codeforge.ai.autoApproveEdits': true,
		'codeforge.ai.autoApprove': [
			'shell',
			'dotnet',
			'edit',
			'write',
			'apply_patch',
			'delete',
			'rename',
			'git_add',
			'git_commit',
		],
		'codeforge.ai.contextBudget': numCtx,
		'codeforge.ai.previewEdits': false,
		'codeforge.ai.weakModelMode': weak ? 'on' : 'off',
		'codeforge.ai.shellSandbox': 'unrestricted',
		'codeforge.ai.fullAgentFreedom': true,
	});

	const require = createRequire(import.meta.url);
	const { initApprovalPolicy } = require(path.join(EXT_OUT, 'policy', 'approvalPolicy.js'));
	const { initGovernanceStore } = require(path.join(EXT_OUT, 'governance', 'governanceStore.js'));
	const { VSCodeAIBridge } = require(path.join(EXT_OUT, 'bridge', 'vscodeBridge.js'));
	const { runAgentWithTools } = require(path.join(EXT_OUT, 'agent', 'agentLoop.js'));
	const { runOrchestrated } = require(path.join(EXT_OUT, 'agent', 'orchestratorRun.js'));

	const ctx = fakeExtensionContext(runHome);
	initApprovalPolicy(ctx);
	initGovernanceStore(ctx);

	const probe = await probeToolCallMode(llm);
	if (probe.toolCallMode === 'none' && probe.detail?.startsWith('HTTP')) {
		die(`LLM unreachable: ${probe.detail}`);
	}

	const activities = [];
	const { createProtocolAggregator, flushRunTelemetry } = require(
		path.join(EXT_OUT, 'agent', 'protocolTelemetry.js')
	);
	const protocolAgg = createProtocolAggregator();
	const samplesDir = flags.samplesDir
		? path.resolve(String(flags.samplesDir))
		: path.join(runHome, 'protocol-samples');
	fs.mkdirSync(samplesDir, { recursive: true });
	let sampleN = 0;
	if (flags.profileHome) {
		process.env.CODEFORGE_MODEL_PROFILE_HOME = path.resolve(String(flags.profileHome));
	} else if (!process.env.CODEFORGE_MODEL_PROFILE_HOME) {
		process.env.CODEFORGE_MODEL_PROFILE_HOME = path.join(os.homedir(), '.CodeForge');
	}

	let modelProfile;
	if (flags.profileOverride) {
		let override;
		try {
			override = JSON.parse(String(flags.profileOverride));
		} catch (err) {
			die(`invalid --profileOverride JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
		const { resolveProfileForRun, mergeModelProfile } = require(
			path.join(EXT_OUT, 'agent', 'modelProfile.js')
		);
		modelProfile = mergeModelProfile(
			resolveProfileForRun(llm.serverId || 'default', llm.model, sampling),
			override
		);
	}

	const started = Date.now();
	let reply = '';
	let loopExit = 'unknown';
	try {
		const bridge = new VSCodeAIBridge(vscode.window.createOutputChannel());
		bridge.setFallbackWorkspaceRoot(workspace);
		const agentOpts = {
			...(modelProfile ? { modelProfile } : {}),
			bridge,
			provider: llm.provider,
			apiKey: llm.apiKey,
			model: llm.model,
			baseUrl: llm.baseUrl,
			workspaceRoot: workspace,
			task: String(task),
			history: [],
			cancelled: () => false,
			numCtx,
			forceJson: llm.forceJson,
			maxSteps: Number(flags.maxSteps || 30),
			hardCap: Number(flags.hardCap || 100),
			weakProfile: weak,
			isolated: true,
			sampling,
			serverId: llm.serverId,
			onActivity: ev => {
				activities.push(ev);
				protocolAgg.observe(ev);
				if (ev.kind === 'protocol' && ev.label === 'sample') {
					sampleN += 1;
					const file = path.join(samplesDir, `${String(sampleN).padStart(3, '0')}.json`);
					try {
						const parsed = JSON.parse(String(ev.detail || '{}'));
						fs.writeFileSync(
							file,
							JSON.stringify(
								{
									at: new Date().toISOString(),
									model: llm.model,
									server: llm.serverName,
									...parsed,
								},
								null,
								2
							)
						);
					} catch {
						fs.writeFileSync(file, String(ev.detail || ''), 'utf8');
					}
				}
			},
			onStatus: text => {
				// Fallback only — prefer onLoopExit when the agent reports it.
				if (loopExit !== 'unknown') return;
				if (/stuck/i.test(text)) loopExit = 'stuck';
				else if (/budget|maximum steps|step budget/i.test(text)) loopExit = 'budget';
				else if (/length|truncat/i.test(text)) loopExit = 'length';
			},
			onLoopExit: exit => {
				loopExit = exit;
			},
		};
		// Same path as chat: multi-card tasks run one isolated sub-run per card.
		const orchestrated = await runOrchestrated(agentOpts, { forced: false });
		reply = orchestrated ?? (await runAgentWithTools(agentOpts));
		// Orchestrator report wins over a sub-run's length/budget status line.
		const planDone = /Progress\s*\((\d+)\/\1\s+done\)/i.exec(String(reply || ''));
		if (planDone && !/\bis blocked\b/i.test(String(reply || ''))) {
			loopExit = 'done';
		} else if (loopExit === 'unknown') {
			loopExit = 'done';
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/fetch failed|ECONNREFUSED|ENOTFOUND|401|403/i.test(msg)) {
			die(`LLM request failed: ${msg}`);
		}
		reply = `error: ${msg}`;
		loopExit = 'error';
	}

	const refusals = {};
	for (const a of activities) {
		const m = /blocked \(([^)]+)\)/i.exec(`${a.label || ''} ${a.detail || ''}`);
		if (m) {
			const key = m[1].toLowerCase();
			refusals[key] = (refusals[key] || 0) + 1;
		}
	}

	const elapsedMs = Date.now() - started;
	const protocolSnap = protocolAgg.snapshot();
	try {
		flushRunTelemetry({
			serverId: llm.serverId,
			model: llm.model,
			source: 'bench',
			loopExit,
			elapsedMs,
			aggregator: protocolAgg,
		});
	} catch {
		/* best-effort */
	}

	const result = {
		runtime: 'headless',
		model: llm.model,
		server: llm.serverName,
		serverId: llm.serverId,
		weakProfile: weak,
		...(modelProfile ? { profileOverride: JSON.parse(String(flags.profileOverride)) } : {}),
		numCtx,
		toolCallMode: probe.toolCallMode,
		toolCallModeDetail: probe.detail,
		elapsedMs,
		loopExit,
		steps: activities.filter(a => a.kind === 'tool').length,
		refusals,
		protocol: protocolSnap.protocol,
		sampleCount: sampleN,
		toolLog: activities
			.filter(a => a.kind === 'tool' || a.kind === 'checkpoint')
			.map(a => `${a.kind === 'tool' ? a.toolStatus || 'tool' : 'checkpoint'} ${a.label || ''} ${String(a.detail || '').slice(0, 160)}`.trim()),
		replyPreview: String(reply).slice(0, 500),
		replyTail: String(reply).trim().slice(-500),
		samplesDir,
	};
	const outPath = flags.out ? path.resolve(String(flags.out)) : path.join(runHome, 'headless-result.json');
	fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
