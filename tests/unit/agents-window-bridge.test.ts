/**
 * Agents window bridge: the chat participant must report real turn outcomes, and
 * the `codeforge` language models must call the configured server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	agentsTurnText,
	CODEFORGE_LM_VENDOR,
	createAgentsRequestHandler,
	followupsForResult,
	listAgentsModels,
	modelIdFor,
	parseModelId,
	renderActivity,
	resultForTurn,
} from '../../extensions/codeforge/src/agents/agentsBridge';
import {
	createLanguageModelProvider,
	modelInformation,
	readOpenAiStream,
	sendChat,
	toAnthropicRequest,
	toOpenAiMessages,
} from '../../extensions/codeforge/src/agents/languageModelProvider';
import { AiSettingsStore, type AiServer, type AiSettingsState } from '../../extensions/codeforge/src/settings/aiSettingsStore';
import { codeforgeAgentsWindowSetting } from '../../resources/vscode-overlay/src/vs/sessions/services/configuration/common/codeforgeAgentsWindowSettings';
import type { AgentsTurnResult, TurnObserver } from '../../extensions/codeforge/src/views/turnContract';

const llama: AiServer = {
	id: 'llama',
	name: 'Llama Server',
	kind: 'openai',
	baseUrl: 'https://llm.example/v1/',
	apiKey: 'secret',
	models: ['qwen3.6-35b', 'gemma4-12b'],
	enabled: true,
};
const claude: AiServer = {
	id: 'claude',
	name: 'Anthropic',
	kind: 'anthropic',
	baseUrl: 'https://api.anthropic.com/v1',
	apiKey: 'sk-ant',
	models: ['claude-sonnet-4'],
	enabled: true,
};
const disabled: AiServer = { ...llama, id: 'off', name: 'Off', models: ['x'], enabled: false };

function storeWith(servers: AiServer[], active?: { serverId: string; model: string }) {
	const state: AiSettingsState = {
		servers,
		activeServerId: active?.serverId ?? null,
		activeModel: active?.model ?? null,
		mcpServers: [],
	};
	return {
		getState: () => state,
		getActiveSelection: () => {
			const server = servers.find(s => s.id === state.activeServerId);
			return server ? { server, model: state.activeModel ?? undefined } : {};
		},
		onDidChange: () => ({ dispose() {} }),
	};
}

function user(...content: unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined };
}
function assistant(...content: unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined };
}

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line));
			controller.close();
		},
	});
}

function recordingStream() {
	const markdown: string[] = [];
	const progress: string[] = [];
	return {
		markdown,
		progress,
		stream: { markdown: (v: string) => markdown.push(v), progress: (v: string) => progress.push(v) },
	};
}

describe('agents bridge: model ids', () => {
	it('round-trips serverId::model, including models with slashes', () => {
		const id = modelIdFor('router', 'anthropic/claude-sonnet-4');
		expect(parseModelId(id)).toEqual({ serverId: 'router', model: 'anthropic/claude-sonnet-4' });
		expect(parseModelId('no-separator')).toBeUndefined();
	});

	it('lists every server model and the active one', () => {
		const listed = listAgentsModels(storeWith([llama], { serverId: 'llama', model: 'gemma4-12b' }));
		expect(listed.models.map(m => m.id)).toEqual(['llama::qwen3.6-35b', 'llama::gemma4-12b']);
		expect(listed.activeModelId).toBe('llama::gemma4-12b');
	});
});

describe('agents bridge: turn outcomes', () => {
	const finished = (loopExit: 'done' | 'budget' | 'stuck' | 'length' | 'error', reply = 'reply'): AgentsTurnResult => ({
		kind: 'finished',
		sessionId: 's1',
		reply,
		loopExit,
	});

	it('reports stuck, length and error as failures, not as success', () => {
		expect(resultForTurn(finished('stuck')).errorDetails?.message).toMatch(/stuck/);
		expect(resultForTurn(finished('length')).errorDetails?.message).toMatch(/length/);
		expect(resultForTurn(finished('error', 'Error: 502 Bad Gateway')).errorDetails?.message).toBe('Error: 502 Bad Gateway');
		expect(resultForTurn({ kind: 'busy' }).errorDetails?.message).toMatch(/slots are in use/);
	});

	it('treats done and budget as completed turns', () => {
		expect(resultForTurn(finished('done')).errorDetails).toBeUndefined();
		expect(resultForTurn(finished('budget')).metadata).toEqual({ loopExit: 'budget', sessionId: 's1' });
	});

	it('offers Continue only when the step budget ended the turn', () => {
		expect(followupsForResult(resultForTurn(finished('budget')))).toHaveLength(1);
		expect(followupsForResult(resultForTurn(finished('done')))).toHaveLength(0);
		expect(followupsForResult(resultForTurn(finished('stuck')))).toHaveLength(0);
	});

	it('keeps finished tool calls in the transcript and running ones as progress', () => {
		const { stream, markdown, progress } = recordingStream();
		renderActivity({ kind: 'tool', label: 'read src/a.ts', toolStatus: 'running' } as never, stream);
		renderActivity({ kind: 'tool', label: 'read src/a.ts', toolStatus: 'done', success: true } as never, stream);
		renderActivity({ kind: 'tool', label: 'run npm test', toolStatus: 'failed', success: false } as never, stream);
		expect(progress).toEqual(['read src/a.ts']);
		expect(markdown).toEqual(['- ✓ read src/a.ts\n', '- ✗ run npm test\n']);
	});

	it('shows the model reasoning as a quoted aside instead of dropping it', () => {
		const { stream, markdown } = recordingStream();
		renderActivity(
			{ kind: 'thought', label: 'Thought briefly', detail: 'Plan: check Azure, then list webapps.' } as never,
			stream
		);
		expect(markdown).toHaveLength(1);
		expect(markdown[0]).toMatch(/💭/);
		expect(markdown[0]).toMatch(/Plan: check Azure, then list webapps\./);
	});

	it('does not render an empty thought', () => {
		const { stream, markdown, progress } = recordingStream();
		renderActivity({ kind: 'thought', label: 'Thought briefly', detail: '' } as never, stream);
		expect(markdown).toHaveLength(0);
		expect(progress).toHaveLength(0);
	});
});

describe('agents bridge: request handler', () => {
	function handlerWith(result: AgentsTurnResult, events: (o: TurnObserver) => void = () => undefined) {
		const calls: Array<{ task: string; sessionId: string | undefined }> = [];
		const selected: string[] = [];
		const map = new Map<string, string>([['chat-1', 'existing-session']]);
		const handler = createAgentsRequestHandler(
			{
				runAgentsTurn: async (task, sessionId, observer) => {
					calls.push({ task, sessionId });
					events(observer);
					return result;
				},
			},
			{ get: k => map.get(k), set: async (k, v) => void map.set(k, v) },
			async id => void selected.push(id)
		);
		return { handler, calls, selected, map };
	}

	const request = (model: { vendor: string; id: string }, chat = 'chat-1') =>
		({ prompt: 'fix the build', sessionId: chat, model }) as unknown as vscode.ChatRequest;

	it('runs the harness turn in the mapped session with the picked CodeForge model', async () => {
		const { handler, calls, selected, map } = handlerWith({ kind: 'finished', sessionId: 'existing-session', reply: 'Done.', loopExit: 'done' });
		const { stream, markdown } = recordingStream();
		const result = await handler(request({ vendor: CODEFORGE_LM_VENDOR, id: 'llama::gemma4-12b' }), {} as never, stream as never, {} as never);
		expect(selected).toEqual(['llama::gemma4-12b']);
		expect(calls).toEqual([{ task: 'fix the build', sessionId: 'existing-session' }]);
		expect(markdown.join('')).toContain('Done.');
		expect((result as vscode.ChatResult).errorDetails).toBeUndefined();
		expect(map.get('chat-1')).toBe('existing-session');
	});

	it('rebuilds a participant slash command so the harness can dispatch it', async () => {
		const { handler, calls } = handlerWith({ kind: 'finished', sessionId: 'existing-session', reply: 'Reviewed.', loopExit: 'done' });
		const { stream } = recordingStream();
		const request = { prompt: 'foo', command: 'review', sessionId: 'chat-1', model: { vendor: 'other', id: 'x' } } as unknown as vscode.ChatRequest;
		await handler(request, {} as never, stream as never, {} as never);
		expect(calls).toEqual([{ task: '/review foo', sessionId: 'existing-session' }]);
		expect(agentsTurnText({ prompt: '', command: 'help' })).toBe('/help');
		expect(agentsTurnText({ prompt: 'fix the build' })).toBe('fix the build');
	});

	it('does not stream the reply as an answer when the turn errored', async () => {
		const { handler, selected } = handlerWith({ kind: 'finished', sessionId: 'new', reply: 'Error: boom', loopExit: 'error' });
		const { stream, markdown } = recordingStream();
		const result = (await handler(request({ vendor: 'other', id: 'x' }, 'chat-2'), {} as never, stream as never, {} as never)) as vscode.ChatResult;
		expect(selected).toEqual([]);
		expect(markdown).toEqual([]);
		expect(result.errorDetails?.message).toBe('Error: boom');
	});
});

describe('codeforge language models', () => {
	it('publishes enabled server models with tool calling', () => {
		const infos = modelInformation(storeWith([llama, disabled]));
		expect(infos.map(i => i.id)).toEqual(['llama::qwen3.6-35b', 'llama::gemma4-12b']);
		expect(infos[0]).toMatchObject({ name: 'qwen3.6-35b', detail: 'Llama Server', capabilities: { toolCalling: true } });
	});

	it('converts tool calls and results to OpenAI messages', () => {
		const messages = toOpenAiMessages([
			user(new vscode.LanguageModelTextPart('list files')),
			assistant(new vscode.LanguageModelToolCallPart('c1', 'ls', { path: '.' })),
			user(new vscode.LanguageModelToolResultPart('c1', [new vscode.LanguageModelTextPart('a.ts\nb.ts')])),
		]);
		expect(messages).toEqual([
			{ role: 'user', content: 'list files' },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } }] },
			{ role: 'tool', tool_call_id: 'c1', content: 'a.ts\nb.ts' },
		]);
	});

	it('converts tool calls and results to Anthropic blocks', () => {
		const { messages } = toAnthropicRequest([
			assistant(new vscode.LanguageModelToolCallPart('t1', 'ls', {})),
			user(new vscode.LanguageModelToolResultPart('t1', [new vscode.LanguageModelTextPart('a.ts')])),
		]);
		expect(messages).toEqual([
			{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts' }] },
		]);
	});

	it('assembles streamed text and tool-call deltas', async () => {
		const parts: unknown[] = [];
		await readOpenAiStream(
			sseBody([
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n',
				'data: [DONE]\n',
			]),
			part => parts.push(part)
		);
		expect(parts).toEqual([
			new vscode.LanguageModelTextPart('Hel'),
			new vscode.LanguageModelTextPart('lo'),
			new vscode.LanguageModelToolCallPart('c9', 'read', { path: 'a.ts' }),
		]);
	});

	it('fails on malformed tool arguments instead of inventing input', async () => {
		await expect(
			readOpenAiStream(
				sseBody(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{oops"}}]}}]}\n', 'data: [DONE]\n']),
				() => undefined
			)
		).rejects.toThrow(/invalid JSON arguments/);
	});

	it('posts to the configured server with key, model and tools', async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;
		const parts: unknown[] = [];
		await sendChat(
			llama,
			'qwen3.6-35b',
			[user(new vscode.LanguageModelTextPart('hello'))],
			{ tools: [{ name: 'ls', description: 'List files', inputSchema: { type: 'object' } }], toolMode: vscode.LanguageModelChatToolMode.Auto },
			p => parts.push(p),
			new AbortController().signal,
			fakeFetch
		);
		expect(seen[0].url).toBe('https://llm.example/v1/chat/completions');
		expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
		const body = JSON.parse(String(seen[0].init.body));
		expect(body.model).toBe('qwen3.6-35b');
		expect(body.tools[0].function.name).toBe('ls');
		expect(body.tool_choice).toBe('auto');
		expect(parts).toEqual([new vscode.LanguageModelTextPart('hi')]);
	});

	it('uses the native Anthropic API for Anthropic servers', async () => {
		const seen: string[] = [];
		const fakeFetch = (async (url: string) => {
			seen.push(url);
			return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'u1', name: 'ls', input: { path: '.' } }] }), { status: 200 });
		}) as unknown as typeof fetch;
		const parts: unknown[] = [];
		await sendChat(claude, 'claude-sonnet-4', [user(new vscode.LanguageModelTextPart('hi'))], {}, p => parts.push(p), new AbortController().signal, fakeFetch);
		expect(seen).toEqual(['https://api.anthropic.com/v1/messages']);
		expect(parts).toEqual([new vscode.LanguageModelToolCallPart('u1', 'ls', { path: '.' })]);
	});

	it('surfaces server errors', async () => {
		const fakeFetch = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
		await expect(
			sendChat(llama, 'qwen3.6-35b', [user(new vscode.LanguageModelTextPart('hi'))], {}, () => undefined, new AbortController().signal, fakeFetch)
		).rejects.toThrow('LLM error 502: bad gateway');
	});

	it('rejects models that are not configured', async () => {
		const provider = createLanguageModelProvider(storeWith([llama]), (async () => {
			throw new Error('must not call the network');
		}) as unknown as typeof fetch);
		const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
		await expect(
			provider.provideLanguageModelChatResponse(
				{ id: 'llama::not-there' } as vscode.LanguageModelChatInformation,
				[],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => undefined },
				token as unknown as vscode.CancellationToken
			)
		).rejects.toThrow('Unknown CodeForge model: llama::not-there');
	});
});

describe('shared settings stay live across windows', () => {
	type Watcher = { pattern: { base: { fsPath: string }; pattern: string }; fire: (kind: 'change' | 'create' | 'delete') => void };
	const watchers = () => (vscode.workspace as unknown as { __fileWatchers: Watcher[] }).__fileWatchers;

	let home: string;
	let previousHome: string | undefined;

	function catalog(models: string[], extra: AiServer[] = []): AiSettingsState {
		return {
			servers: [
				{
					id: 'llama',
					name: 'Llama Server',
					kind: 'ollama',
					baseUrl: 'http://127.0.0.1:8080/v1',
					models,
					enabled: true,
				},
				...extra,
			],
			activeServerId: 'llama',
			activeModel: models[0] ?? null,
			mcpServers: [],
		};
	}

	function context() {
		const stored = new Map<string, unknown>();
		const secretValues = new Map<string, string>();
		const secretListeners: Array<(e: { key: string }) => void> = [];
		return {
			subscriptions: [] as { dispose(): void }[],
			globalState: {
				get: (key: string) => stored.get(key),
				update: async (key: string, value: unknown) => void stored.set(key, value),
			},
			secrets: {
				get: async (key: string) => secretValues.get(key),
				store: async (key: string, value: string) => void secretValues.set(key, value),
				delete: async (key: string) => void secretValues.delete(key),
				onDidChange: (listener: (e: { key: string }) => void) => {
					secretListeners.push(listener);
					return { dispose() { /* listener lives for the test */ } };
				},
				fire(key: string) {
					for (const listener of secretListeners) listener({ key });
				},
				secretValues,
			},
		};
	}

	beforeEach(() => {
		previousHome = process.env.CODEFORGE_HOME;
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-ai-'));
		process.env.CODEFORGE_HOME = home;
		watchers().length = 0;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.CODEFORGE_HOME;
		else process.env.CODEFORGE_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('publishes only the enabled servers models when another window writes settings.json', async () => {
		const file = path.join(home, 'ai', 'settings.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const many = ['qwen3.6-35b', 'gemma4-12b', 'bonsai-2-27b', 'llama-other'];
		fs.writeFileSync(file, JSON.stringify(catalog(many)));

		const store = new AiSettingsStore(context() as unknown as vscode.ExtensionContext);
		const watcher = watchers().at(-1);
		expect(watcher?.pattern.pattern).toBe('settings.json');
		expect(watcher?.pattern.base.fsPath).toBe(path.dirname(file));

		const published: string[][] = [];
		store.onDidChange(state => published.push(state.servers.flatMap(s => (s.enabled === false ? [] : s.models))));

		const disabled: AiServer = {
			id: 'off',
			name: 'Off',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:9/v1',
			models: ['ghost-model'],
			enabled: false,
		};
		fs.writeFileSync(file, JSON.stringify(catalog(['qwen3.6-35b'], [disabled])));
		watcher!.fire('change');
		await new Promise(resolve => setImmediate(resolve));

		expect(published).toEqual([['qwen3.6-35b']]);
		expect(modelInformation(store).map(info => info.name)).toEqual(['qwen3.6-35b']);
	});

	it('does not notify again when this window saved the file and the watcher echoes it', async () => {
		const ctx = context();
		const store = new AiSettingsStore(ctx as unknown as vscode.ExtensionContext);
		const seen: string[] = [];
		store.onDidChange(state => seen.push(state.activeModel ?? ''));
		await store.save(catalog(['qwen3.6-35b']));
		watchers().at(-1)!.fire('change');
		await new Promise(resolve => setImmediate(resolve));
		expect(seen).toEqual(['qwen3.6-35b']);
	});

	it('reloads API keys when SecretStorage changes in another window', async () => {
		const file = path.join(home, 'ai', 'settings.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(catalog(['qwen3.6-35b'])));
		const ctx = context();
		ctx.secrets.secretValues.set('codeforge.ai.server.llama.apiKey', 'sk-live');
		const store = new AiSettingsStore(ctx as unknown as vscode.ExtensionContext);
		await store.bootstrapSecrets();
		expect(store.getState().servers[0].apiKey).toBe('sk-live');

		ctx.secrets.secretValues.set('codeforge.ai.server.llama.apiKey', 'sk-rotated');
		ctx.secrets.fire('codeforge.ai.server.llama.apiKey');
		await new Promise(resolve => setImmediate(resolve));
		expect(store.getState().servers[0].apiKey).toBe('sk-rotated');
	});
});

describe('Agents window discovery defaults', () => {
	it('turns off VS Code skills, instructions, hooks and MCP', () => {
		const locations = [
			'chat.promptFilesLocations',
			'chat.instructionsFilesLocations',
			'chat.agentFilesLocations',
			'chat.agentSkillsLocations',
			'chat.hookFilesLocations',
		];
		for (const key of locations) {
			expect(codeforgeAgentsWindowSetting(key)?.value).toBe(false);
		}
		expect(codeforgeAgentsWindowSetting('chat.useAgentSkills')?.value).toBe(false);
		expect(codeforgeAgentsWindowSetting('chat.useAgentsMdFile')?.value).toBe(false);
		expect(codeforgeAgentsWindowSetting('chat.useHooks')?.value).toBe(false);
		expect(codeforgeAgentsWindowSetting('chat.plugins.enabled')?.value).toBe(false);
		expect(codeforgeAgentsWindowSetting('chat.includeApplyingInstructions')?.value).toBe(false);
		expect(codeforgeAgentsWindowSetting('chat.mcp.access')?.value).toBe('none');
		expect(codeforgeAgentsWindowSetting('chat.experimental.collectInstructionsInExtension')?.value).toBe(true);
		expect(codeforgeAgentsWindowSetting('chat.not.a.setting')).toBeUndefined();
	});
});
