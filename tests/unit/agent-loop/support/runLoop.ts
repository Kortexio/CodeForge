/**
 * Headless runner for runAgentWithTools with a temp workspace + scripted (or live) LLM.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	getRecordedRequests,
	installScriptedModel,
	uninstallScriptedModel,
	type RecordedRequest,
	type ScriptedStep,
} from './scriptedModel';

export type RunLoopFiles = Record<string, string>;

export type RunLoopOptions = {
	files?: RunLoopFiles;
	task: string;
	script?: ScriptedStep[];
	/** When true, do not install the scripted fetch (use real network). */
	live?: boolean;
	weakProfile?: boolean;
	planMode?: boolean;
	askMode?: boolean;
	isolated?: boolean;
	maxSteps?: number;
	hardCap?: number;
	numCtx?: number;
	model?: string;
	provider?: string;
	baseUrl?: string;
	apiKey?: string;
	forceJson?: boolean;
	sessionId?: string | null;
	history?: Array<{ role: 'user' | 'assistant'; content: string }>;
	config?: Record<string, unknown>;
	/** Optional LSP diagnostics map (path → diags) for __setDiagnostics. */
	diagnostics?: Map<string, unknown> | Record<string, unknown>;
};

export type RunLoopResult = {
	reply: string;
	requests: RecordedRequest[];
	activities: Array<{ kind?: string; label?: string; tool?: string; detail?: string }>;
	files: Map<string, string>;
	workspaceRoot: string;
	codeforgeHome: string;
};

function fakeExtensionContext(): import('vscode').ExtensionContext {
	const store = new Map<string, unknown>();
	return {
		subscriptions: [],
		workspaceState: {
			get: (k: string, d?: unknown) => (store.has(`ws:${k}`) ? store.get(`ws:${k}`) : d),
			update: async (k: string, v: unknown) => {
				store.set(`ws:${k}`, v);
			},
			keys: () => [...store.keys()].filter(k => k.startsWith('ws:')).map(k => k.slice(3)),
		},
		globalState: {
			get: (k: string, d?: unknown) => (store.has(`g:${k}`) ? store.get(`g:${k}`) : d),
			update: async (k: string, v: unknown) => {
				store.set(`g:${k}`, v);
			},
			keys: () => [...store.keys()].filter(k => k.startsWith('g:')).map(k => k.slice(2)),
			setKeysForSync: () => undefined,
		},
		extensionUri: { fsPath: __dirname } as import('vscode').Uri,
		extensionPath: __dirname,
		storageUri: undefined,
		globalStorageUri: { fsPath: os.tmpdir() } as import('vscode').Uri,
		logUri: { fsPath: os.tmpdir() } as import('vscode').Uri,
		storagePath: undefined,
		globalStoragePath: os.tmpdir(),
		logPath: os.tmpdir(),
		extensionMode: 3,
		secrets: {
			get: async () => undefined,
			store: async () => undefined,
			delete: async () => undefined,
			onDidChange: () => ({ dispose() {} }),
		},
		environmentVariableCollection: {} as import('vscode').GlobalEnvironmentVariableCollection,
		extension: {} as import('vscode').Extension<unknown>,
		asAbsolutePath: (p: string) => path.join(__dirname, p),
		languageModelAccessInformation: {} as import('vscode').LanguageModelAccessInformation,
	} as unknown as import('vscode').ExtensionContext;
}

async function writeTree(root: string, files: RunLoopFiles): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel.replace(/\//g, path.sep));
		await fsp.mkdir(path.dirname(abs), { recursive: true });
		await fsp.writeFile(abs, content, 'utf8');
	}
}

async function readTree(root: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const walk = async (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'bin' || ent.name === 'obj') {
				continue;
			}
			if (ent.isDirectory()) await walk(full);
			else if (ent.isFile()) {
				const rel = path.relative(root, full).replace(/\\/g, '/');
				out.set(rel, await fsp.readFile(full, 'utf8'));
			}
		}
	};
	await walk(root);
	return out;
}

export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
	const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-loop-ws-'));
	const codeforgeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-loop-home-'));
	const prevHome = process.env.CODEFORGE_HOME;
	process.env.CODEFORGE_HOME = codeforgeHome;

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const vscodeMock = require('../../../support/vscodeFsMock') as {
		__setWorkspace: (r: string) => void;
		__setConfig: (c: Record<string, unknown>) => void;
		__setDiagnostics: (m: unknown) => void;
		window: { createOutputChannel: () => unknown };
	};
	vscodeMock.__setWorkspace(workspaceRoot);
	vscodeMock.__setConfig({
		'codeforge.ai.autoApproveEdits': true,
		'codeforge.ai.autoApprove': ['shell', 'dotnet', 'edit', 'write', 'apply_patch', 'delete', 'rename'],
		'codeforge.ai.contextBudget': opts.numCtx ?? 32768,
		'codeforge.ai.previewEdits': false,
		'codeforge.ai.weakModelMode': opts.weakProfile === false ? 'off' : 'on',
		'codeforge.ai.shellSandbox': 'unrestricted',
		'codeforge.ai.fullAgentFreedom': true,
		...(opts.config ?? {}),
	});
	if (opts.diagnostics) {
		vscodeMock.__setDiagnostics(opts.diagnostics);
	} else {
		vscodeMock.__setDiagnostics(new Map());
	}

	await writeTree(workspaceRoot, opts.files ?? { 'README.md': '# fixture\n' });

	if (opts.live) {
		uninstallScriptedModel();
	} else {
		if (!opts.script?.length) {
			throw new Error('runLoop: script is required unless live=true');
		}
		installScriptedModel(opts.script);
	}

	const activities: RunLoopResult['activities'] = [];

	try {
		const ctx = fakeExtensionContext();
		const { initApprovalPolicy } = await import(
			'../../../../extensions/codeforge/src/policy/approvalPolicy'
		);
		initApprovalPolicy(ctx);
		const { initGovernanceStore } = await import(
			'../../../../extensions/codeforge/src/governance/governanceStore'
		);
		initGovernanceStore(ctx);

		const { VSCodeAIBridge } = await import(
			'../../../../extensions/codeforge/src/bridge/vscodeBridge'
		);
		const { runAgentWithTools } = await import(
			'../../../../extensions/codeforge/src/agent/agentLoop'
		);

		const bridge = new VSCodeAIBridge(
			vscodeMock.window.createOutputChannel() as import('vscode').OutputChannel
		);
		bridge.setFallbackWorkspaceRoot(workspaceRoot);

		const reply = await runAgentWithTools({
			bridge,
			provider: opts.provider ?? 'openai',
			apiKey: opts.apiKey ?? 'test-key',
			model: opts.model ?? 'scripted-model',
			baseUrl: opts.baseUrl ?? 'http://127.0.0.1:9/v1',
			workspaceRoot,
			task: opts.task,
			history: opts.history ?? [],
			cancelled: () => false,
			onActivity: ev => {
				activities.push({
					kind: ev.kind,
					label: ev.label,
					tool: ev.tool,
					detail: ev.detail,
				});
			},
			onStatus: () => undefined,
			numCtx: opts.numCtx ?? 32768,
			forceJson: opts.forceJson,
			maxSteps: opts.maxSteps ?? 20,
			hardCap: opts.hardCap ?? 40,
			weakProfile: opts.weakProfile !== false,
			planMode: opts.planMode,
			askMode: opts.askMode,
			isolated: opts.isolated ?? true,
			sessionId: opts.sessionId ?? null,
		});

		const files = await readTree(workspaceRoot);
		return {
			reply,
			requests: getRecordedRequests(),
			activities,
			files,
			workspaceRoot,
			codeforgeHome,
		};
	} finally {
		uninstallScriptedModel();
		if (prevHome === undefined) delete process.env.CODEFORGE_HOME;
		else process.env.CODEFORGE_HOME = prevHome;
	}
}
