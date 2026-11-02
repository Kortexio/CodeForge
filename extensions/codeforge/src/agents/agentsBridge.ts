/**
 * Agents window bridge.
 *
 * The Agents window (Code-OSS `vs/sessions`) renders its own composer and chat
 * transcript. Its CodeForge sessions provider sends every turn to the
 * `codeforge.agent` chat participant below, which runs the side chat's
 * pipeline (`ChatViewProvider.runAgentsTurn`) and streams the result back.
 * The provider reads and writes models, mode and permissions through the
 * `codeforge.agents.*` commands, which use the same stores as the side chat.
 */

import * as vscode from 'vscode';
import type { AgentActivityEvent } from '../agent/agentLoop';
import type { AiSettingsStore } from '../settings/aiSettingsStore';
import type { PermissionLevel } from '../policy/approvalPolicy';
import type { ChatViewProvider } from '../views/chatView';
import {
	CONTINUE_TURN_PROMPT,
	type AgentsTurnResult,
	type LoopExit,
	type TurnObserver,
} from '../views/turnContract';

export const AGENTS_PARTICIPANT_ID = 'codeforge.agent';
/** `vscode.lm` vendor of the server/model pairs published by `languageModelProvider.ts`. */
export const CODEFORGE_LM_VENDOR = 'codeforge';
const SESSION_MAP_KEY = 'codeforge.agents.chatSessions';
const MODEL_ID_SEPARATOR = '::';

export type AgentsMode = 'ask' | 'plan' | 'agent';

export interface AgentsModel {
	/** `serverId::model`, stable across reloads. */
	id: string;
	serverId: string;
	serverName: string;
	model: string;
}

export interface AgentsHarnessState {
	mode: AgentsMode;
	permission: PermissionLevel;
	fullAgentFreedom: boolean;
	models: AgentsModel[];
	activeModelId: string | undefined;
}

export interface AgentsResultMetadata {
	loopExit: LoopExit;
	sessionId: string | null;
}

/** Minimal stream surface the mapper needs; matches `vscode.ChatResponseStream`. */
export interface AgentsStream {
	markdown(value: string): void;
	progress(value: string): void;
}

export function modelIdFor(serverId: string, model: string): string {
	return `${serverId}${MODEL_ID_SEPARATOR}${model}`;
}

export function parseModelId(id: string): { serverId: string; model: string } | undefined {
	const at = id.indexOf(MODEL_ID_SEPARATOR);
	if (at <= 0) return undefined;
	const model = id.slice(at + MODEL_ID_SEPARATOR.length);
	return model ? { serverId: id.slice(0, at), model } : undefined;
}

export function listAgentsModels(store: Pick<AiSettingsStore, 'getState' | 'getActiveSelection'>): {
	models: AgentsModel[];
	activeModelId: string | undefined;
} {
	const models: AgentsModel[] = [];
	for (const server of store.getState().servers) {
		for (const model of server.models) {
			models.push({ id: modelIdFor(server.id, model), serverId: server.id, serverName: server.name, model });
		}
	}
	const { server, model } = store.getActiveSelection();
	const activeModelId = server && model ? modelIdFor(server.id, model) : undefined;
	return { models, activeModelId };
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_{}[\]()#+!|<>])/g, '\\$1');
}

const THOUGHT_PREVIEW_CHARS = 600;

/** The model's reasoning stays in the transcript as a quoted aside, not the final answer. */
function formatThought(text: string): string {
	const clipped =
		text.length > THOUGHT_PREVIEW_CHARS ? `${text.slice(0, THOUGHT_PREVIEW_CHARS)}…` : text;
	const quoted = escapeMarkdown(clipped)
		.split(/\r?\n/)
		.map(line => `> ${line}`)
		.join('\n');
	return `> 💭 _Thinking…_\n${quoted}\n\n`;
}

/**
 * Renders one harness activity event into the Agents chat stream.
 * Finished tool calls stay in the transcript; transient states become progress.
 */
export function renderActivity(event: AgentActivityEvent, stream: AgentsStream): void {
	const label = String(event.label || '').replace(/\s+/g, ' ').trim();
	switch (event.kind) {
		case 'tool': {
			if (!label) return;
			if (event.toolStatus === 'running') {
				stream.progress(label);
				return;
			}
			const failed = event.toolStatus === 'failed' || event.success === false;
			stream.markdown(`- ${failed ? '✗' : '✓'} ${escapeMarkdown(label)}\n`);
			return;
		}
		case 'checkpoint':
		case 'thinking':
		case 'compact':
		case 'context':
			if (label) stream.progress(label);
			return;
		case 'thought': {
			const text = String(event.detail || '').trim();
			if (!text) return;
			stream.markdown(formatThought(text));
			return;
		}
		case 'protocol':
			return;
	}
}

const FAILURE_MESSAGES: Partial<Record<LoopExit, string>> = {
	stuck: 'The agent stopped because it was not making progress (stuck loop). Nothing was retried automatically.',
	length: 'The model output hit its length limit before the turn finished.',
	error: 'The turn failed.',
};

/** Maps a finished turn to the chat result. Stuck, length and error are failures. */
export function resultForTurn(result: AgentsTurnResult): vscode.ChatResult {
	if (result.kind === 'busy') {
		return {
			errorDetails: {
				message: 'CodeForge is already running a turn in another chat. Wait for it to finish or stop it, then send again.',
			},
		};
	}
	const metadata: AgentsResultMetadata = { loopExit: result.loopExit, sessionId: result.sessionId };
	const failure = FAILURE_MESSAGES[result.loopExit];
	if (failure) {
		const detail = result.loopExit === 'error' && result.reply ? result.reply : failure;
		return { errorDetails: { message: detail }, metadata };
	}
	return { metadata };
}

/** Continue is offered only when the step budget ended the turn. */
export function followupsForResult(result: vscode.ChatResult): vscode.ChatFollowup[] {
	const metadata = result.metadata as Partial<AgentsResultMetadata> | undefined;
	if (metadata?.loopExit !== 'budget') return [];
	return [{ prompt: CONTINUE_TURN_PROMPT, label: 'Continue', participant: AGENTS_PARTICIPANT_ID }];
}

type AgentsTurnRunner = Pick<ChatViewProvider, 'runAgentsTurn'>;

/** Chat resource → CodeForge SessionStore id, persisted so reopened chats resume their session. */
class ChatSessionMap {
	constructor(private readonly memento: vscode.Memento) {}

	get(chatKey: string): string | undefined {
		return this.memento.get<Record<string, string>>(SESSION_MAP_KEY, {})[chatKey];
	}

	async set(chatKey: string, sessionId: string): Promise<void> {
		const map = { ...this.memento.get<Record<string, string>>(SESSION_MAP_KEY, {}) };
		if (map[chatKey] === sessionId) return;
		map[chatKey] = sessionId;
		await this.memento.update(SESSION_MAP_KEY, map);
	}
}

function chatKeyOf(request: vscode.ChatRequest): string | undefined {
	const withSession = request as vscode.ChatRequest & { sessionResource?: vscode.Uri; sessionId?: string };
	return withSession.sessionResource?.toString() ?? withSession.sessionId;
}

/**
 * A participant command arrives as `request.command` with the slash stripped
 * and the rest in `prompt`. The harness dispatches the same `/command args`
 * text as the side chat.
 */
export function agentsTurnText(request: { prompt: string; command?: string }): string {
	const command = request.command?.replace(/^\//, '').trim();
	if (!command) return request.prompt;
	const args = request.prompt.trim();
	return args ? `/${command} ${args}` : `/${command}`;
}

export function createAgentsRequestHandler(
	runner: AgentsTurnRunner,
	sessions: { get(chatKey: string): string | undefined; set(chatKey: string, sessionId: string): Promise<void> },
	selectModel: (modelId: string) => Promise<void>
): vscode.ChatRequestHandler {
	return async (request, _context, stream, token) => {
		const chatKey = chatKeyOf(request);
		if (request.model?.vendor === CODEFORGE_LM_VENDOR) {
			await selectModel(request.model.id);
		}
		const observer: TurnObserver = {
			onActivity: event => renderActivity(event, stream),
			onStatus: text => {
				const status = String(text || '').replace(/\s+/g, ' ').trim();
				if (status) stream.progress(status.slice(0, 120));
			},
		};
		const result = await runner.runAgentsTurn(
			agentsTurnText(request),
			chatKey ? sessions.get(chatKey) : undefined,
			observer,
			token
		);
		if (result.kind === 'finished') {
			if (chatKey && result.sessionId) {
				await sessions.set(chatKey, result.sessionId);
			}
			if (result.reply && result.loopExit !== 'error') {
				stream.markdown(`\n${result.reply}`);
			}
		}
		return resultForTurn(result);
	};
}

function normalizeAgentsMode(value: unknown): AgentsMode | undefined {
	return value === 'ask' || value === 'plan' || value === 'agent' ? value : undefined;
}

function normalizePermission(value: unknown): PermissionLevel | undefined {
	return value === 'default' || value === 'assisted' || value === 'allowAll' ? value : undefined;
}

export function registerAgentsBridge(
	context: vscode.ExtensionContext,
	chatView: ChatViewProvider,
	store: AiSettingsStore
): void {
	const sessions = new ChatSessionMap(context.globalState);
	const selectModel = async (id: string): Promise<void> => {
		const parsed = parseModelId(id);
		const server = parsed && store.getState().servers.find(s => s.id === parsed.serverId);
		if (!parsed || !server || !server.models.includes(parsed.model)) {
			throw new Error(`Unknown CodeForge model: ${id}`);
		}
		const active = store.getActiveSelection();
		if (active.server?.id === parsed.serverId && active.model === parsed.model) return;
		await store.setActiveModel(parsed.serverId, parsed.model);
		chatView.refreshConfig();
	};
	const participant = vscode.chat.createChatParticipant(
		AGENTS_PARTICIPANT_ID,
		createAgentsRequestHandler(chatView, sessions, selectModel)
	);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'ai-icon.svg');
	participant.followupProvider = { provideFollowups: result => followupsForResult(result) };
	context.subscriptions.push(participant);

	const harnessState = (): AgentsHarnessState => ({
		mode: chatView.getMode(),
		permission: chatView.getPermissions(),
		fullAgentFreedom: vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('fullAgentFreedom') === true,
		...listAgentsModels(store),
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('codeforge.agents.getState', () => harnessState()),
		vscode.commands.registerCommand('codeforge.agents.setModel', async (id: unknown) => {
			await selectModel(String(id));
			return harnessState();
		}),
		vscode.commands.registerCommand('codeforge.agents.setMode', async (mode: unknown) => {
			const next = normalizeAgentsMode(mode);
			if (!next) throw new Error(`Unknown CodeForge mode: ${String(mode)}`);
			await chatView.setMode(next);
			return harnessState();
		}),
		vscode.commands.registerCommand('codeforge.agents.setPermission', async (level: unknown) => {
			const next = normalizePermission(level);
			if (!next) throw new Error(`Unknown CodeForge permission level: ${String(level)}`);
			await chatView.setPermissions(next);
			return harnessState();
		}),
		vscode.commands.registerCommand('codeforge.agents.setFullAgentFreedom', async (enabled: unknown) => {
			await vscode.workspace
				.getConfiguration('codeforge.ai')
				.update('fullAgentFreedom', enabled === true, vscode.ConfigurationTarget.Global);
			return harnessState();
		})
	);

	const fireChanged = () => void vscode.commands.executeCommand('_codeforge.agents.stateChanged').then(undefined, () => undefined);
	context.subscriptions.push(
		store.onDidChange(fireChanged),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('codeforge.ai.mode') ||
				e.affectsConfiguration('codeforge.ai.allowAll') ||
				e.affectsConfiguration('codeforge.ai.previewEdits') ||
				e.affectsConfiguration('codeforge.ai.fullAgentFreedom')
			) {
				fireChanged();
			}
		})
	);
}
