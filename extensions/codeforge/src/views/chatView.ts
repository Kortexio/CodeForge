/**
 * CodeForge AI - Chat View (Cursor-like right sidebar)
 *
 * Layout target: Explorer left · Editor center · AI Agent right
 */

import * as vscode from 'vscode';
import { VSCodeAIBridge } from '../bridge/vscodeBridge';
import { AiSettingsStore } from '../settings/aiSettingsStore';
import { runAgentWithTools, AgentActivityEvent } from '../agent/agentLoop';
import { SessionStore } from '../sessions/sessionStore';
import { getApprovalPolicy, PermissionLevel } from '../policy/approvalPolicy';
import { ensureWorkspaceIndex, getIndexedCount } from '../intelligence/workspaceIndex';
import {
	PendingAttachment,
	attachmentFromBlob,
	attachmentFromHttpUrl,
	attachmentsFromUris,
	buildAttachmentPayload,
	isHttpUrl,
	mergeAttachments,
	parseDroppedUriList,
} from './attachments';
import {
	SLASH_COMMANDS,
	formatSlashHelp,
	parseSlashInput,
} from './slashCommands';
import {
	agentsMdExists,
	generateAgentsMd,
	loadAgentsMdForPrompt,
} from '../agent/projectInstructions';
import { isWeakModel, resolveWeakModelMode } from '../agent/weakModelProfile';

type AgentMode = 'ask' | 'plan' | 'agent' | 'auto';
type Permissions = PermissionLevel;

interface TimelineItem {
	id: string;
	kind: AgentActivityEvent['kind'];
	label: string;
	detail?: string;
	tool?: string;
	success?: boolean;
	toolCallId?: string;
	toolStatus?: 'running' | 'ok' | 'failed';
	ts: number;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _extensionUri: vscode.Uri;
	private _messages: ChatMessage[] = [];
	private _timeline: TimelineItem[] = [];
	private _bridge: VSCodeAIBridge;
	private _store: AiSettingsStore;
	private _sessions: SessionStore;
	private _currentSessionId: string | null = null;
	private _cancelled = false;
	private _abort?: AbortController;
	private _mode: AgentMode = 'agent';
	private _permissions: Permissions = 'default';
	private _contextBadge = { indexed: 0, inContext: 0 };
	private _weakHarness = false;
	private _pendingAttachments: PendingAttachment[] = [];
	private _pendingImages: Array<{ mime: string; dataUrl: string; label?: string }> = [];
	private _hasAgentsMd = false;
	private _running = false;
	private _queue: Array<{ id: string; text: string; mode?: AgentMode }> = [];

	constructor(
		extensionUri: vscode.Uri,
		bridge: VSCodeAIBridge,
		_output: vscode.OutputChannel,
		store: AiSettingsStore,
		sessions: SessionStore
	) {
		this._extensionUri = extensionUri;
		this._bridge = bridge;
		this._store = store;
		this._sessions = sessions;
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		this._mode = normalizeMode(cfg.get<string>('mode'));
		try {
			this._permissions = getApprovalPolicy().getPermissionLevel(this._mode);
		} catch {
			this._permissions = this._mode === 'auto' ? 'allowAll' : cfg.get<boolean>('previewEdits') ? 'assisted' : 'default';
		}
		void ensureWorkspaceIndex().then(() => {
			this._contextBadge = { indexed: getIndexedCount(), inContext: this._contextBadge.inContext };
			this.pushConfig();
		});
		void agentsMdExists().then(v => {
			this._hasAgentsMd = v;
			this.pushConfig();
		});
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('codeforge.ai.collapseToolCards') ||
				e.affectsConfiguration('codeforge.ai.enabled')
			) {
				this.updateView();
			}
		});
	}

	refreshConfig() {
		this.pushConfig();
	}

	getCurrentSessionId(): string | null {
		return this._currentSessionId;
	}

	async loadSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			vscode.window.showWarningMessage('Session not found');
			return;
		}
		this._currentSessionId = session.id;
		await this._sessions.setActiveId(session.id);
		try {
			getApprovalPolicy().clearSession();
		} catch {
			/* ignore */
		}
		this._cancelled = false;
		this._timeline = (session.toolTraces || []).slice(-40).map(t => ({
			id: t.id,
			kind: 'tool' as const,
			label: t.success ? `${t.name} ok` : `${t.name} failed`,
			detail: (t.output || '').slice(0, 300),
			tool: t.name,
			toolCallId: t.id,
			toolStatus: (t.success ? 'ok' : 'failed') as 'ok' | 'failed',
			success: t.success,
			ts: Date.parse(t.timestamp) || Date.now(),
		}));
		this._messages = session.messages.map(m => ({
			role: m.role,
			content: m.content,
			timestamp: new Date(m.timestamp),
		}));
		this._queue = [];
		this.pushQueue();
		await this.focus();
		this.updateView();
		if (this._view) {
			this._view.title = session.title.slice(0, 40);
		}
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;
		webviewView.title = 'Agent';
		webviewView.description = this.getModelLabel();

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtmlContent();

		webviewView.webview.onDidReceiveMessage(async message => {
			switch (message.type) {
				case 'ready':
					this.pushConfig();
					this.pushQueue();
					await this.restoreActiveSessionIfNeeded();
					this.updateView();
					break;
				case 'sendMessage':
					await this.handleUserMessage(
						String(message.text ?? ''),
						message.mode as AgentMode | undefined
					);
					break;
				case 'setMode':
					await this.setMode(normalizeMode(message.mode));
					break;
				case 'setPermissions':
					await this.setPermissions(normalizePermissions(message.level));
					break;
				case 'emptyCta':
					if (String(message.action) === 'start') {
						await this.setMode('agent');
						await this.focus();
						this._view?.webview.postMessage({ type: 'focusInput' });
					} else if (String(message.action) === 'instructions') {
						await this.runGenerateInstructions();
					}
					break;
				case 'generateInstructions':
					await this.runGenerateInstructions();
					break;
				case 'configure':
					await vscode.commands.executeCommand('codeforge.switchModel');
					this.pushConfig();
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('codeforge.openSettings');
					this.pushConfig();
					break;
				case 'cancel':
					await this.cancelTask();
					break;
				case 'newChat':
					this.newChat();
					break;
				case 'attachFiles':
					await this.pickAttachments();
					break;
				case 'attachUris':
					await this.attachFromUriList(String(message.uriList ?? ''));
					break;
				case 'attachBlobs':
					await this.attachFromBlobs(
						Array.isArray(message.blobs) ? (message.blobs as Array<{ name: string; mime?: string; base64: string }>) : []
					);
					break;
				case 'attachUrl':
					this.attachHttpUrl(String(message.url ?? ''));
					break;
				case 'removeAttachment':
					this._pendingAttachments = this._pendingAttachments.filter(a => a.id !== String(message.id ?? ''));
					this.pushConfig();
					break;
				case 'clearAttachments':
					this._pendingAttachments = [];
					this.pushConfig();
					break;
				case 'openExternal': {
					const url = String(message.url ?? '');
					if (/^https?:\/\//i.test(url)) {
						await vscode.env.openExternal(vscode.Uri.parse(url));
					}
					break;
				}
				case 'removeQueued':
					this.removeQueued(String(message.id ?? ''));
					break;
				case 'clearQueue':
					this._queue = [];
					this.pushQueue();
					break;
			}
		});
	}

	newChat() {
		this._messages = [];
		this._timeline = [];
		this._queue = [];
		this._running = false;
		this._cancelled = false;
		this._abort?.abort();
		this._abort = undefined;
		this._currentSessionId = null;
		this._pendingAttachments = [];
		void this._sessions.setActiveId(null);
		try {
			getApprovalPolicy().clearSession();
		} catch {
			/* policy may not be ready */
		}
		if (this._view) {
			this._view.title = 'Agent';
		}
		this.updateView();
		this.pushQueue();
		this.pushConfig();
	}

	private async restoreActiveSessionIfNeeded(): Promise<void> {
		if (this._messages.length || this._currentSessionId) return;
		const activeId = this._sessions.getActiveId();
		const session = (activeId && this._sessions.get(activeId)) || this._sessions.latest();
		if (session?.messages.length) {
			this._currentSessionId = session.id;
			this._messages = session.messages.map(m => ({
				role: m.role,
				content: m.content,
				timestamp: new Date(m.timestamp),
			}));
			if (this._view) {
				this._view.title = session.title.slice(0, 40);
			}
		}
	}

	private async maybeResumeForContinue(task: string): Promise<void> {
		if (this._messages.length > 0 || this._currentSessionId) return;
		if (!looksLikeContinue(task)) return;
		const latest = this._sessions.latest();
		if (!latest?.messages.length) return;
		this._currentSessionId = latest.id;
		await this._sessions.setActiveId(latest.id);
		this._messages = latest.messages.map(m => ({
			role: m.role,
			content: m.content,
			timestamp: new Date(m.timestamp),
		}));
		if (this._view) {
			this._view.title = latest.title.slice(0, 40);
		}
		this.updateView();
	}

	async focus() {
		await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
		if (this._view) {
			this._view.show?.(true);
		} else {
			await vscode.commands.executeCommand('codeforge.chat.focus');
		}
	}

	async runTask(task: string, mode?: AgentMode) {
		if (mode) {
			await this.setMode(mode);
		}
		const aiEnabled =
			vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('enabled') !== false;
		if (!aiEnabled) {
			this.addMessage('user', task);
			this.addMessage(
				'assistant',
				'AI Agent is disabled. Enable it in Settings → AI → Agent (`codeforge.ai.enabled`), then try again.'
			);
			return;
		}
		if (this._running) {
			this.enqueueMessage(task, mode);
			return;
		}

		this._running = true;
		this._cancelled = false;
		this._abort?.abort();
		this._abort = new AbortController();
		this._timeline = [];

		await this.maybeResumeForContinue(task);

		const { server, model } = this._store.getActiveSelection();
		if (!this._currentSessionId) {
			const session = await this._sessions.create({
				task,
				model: model,
				serverName: server?.name,
			});
			this._currentSessionId = session.id;
			if (this._view) {
				this._view.title = session.title.slice(0, 40);
			}
		} else {
			await this._sessions.setActiveId(this._currentSessionId);
		}

		if (this._mode === 'auto') {
			try {
				await getApprovalPolicy().allowAutoSession();
			} catch {
				/* ignore */
			}
		}

		const attached = this._pendingAttachments;
		let fullTask = task;
		let images: Array<{ mime: string; dataUrl: string; label?: string }> = [];
		if (attached.length) {
			const payload = buildAttachmentPayload(attached);
			if (payload.textBlock) {
				fullTask = `${task}\n\n${payload.textBlock}`;
			}
			images = payload.images;
			this._pendingAttachments = [];
			this.pushConfig();
		}
		this._pendingImages = images;

		// Keep full content (incl. attachments) in in-memory history for follow-up turns.
		// Images are referenced by label in stored text (base64 kept only for this turn).
		const historyText =
			images.length > 0
				? `${fullTask}\n\n(Attached images: ${images.map(i => i.label || 'image').join(', ')})`
				: fullTask;
		this.addMessage('user', historyText);
		await this._sessions.appendMessage(this._currentSessionId, 'user', historyText);
		await this._sessions.updateState(this._currentSessionId, 'running');

		this.addMessage(
			'assistant',
			this._mode === 'ask' ? 'Thinking...' : 'Working...',
			'pending'
		);
		this.updateView();

		try {
			const reply = await this.executeLocalAgent(fullTask, images);
			if (!this._cancelled) {
				this.updateLastMessage('assistant', reply);
				await this._sessions.appendMessage(this._currentSessionId, 'assistant', reply);
				await this._sessions.updateState(this._currentSessionId, 'completed');
			} else {
				await this._sessions.updateState(this._currentSessionId, 'cancelled');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this._cancelled || /abort/i.test(message)) {
				this.updateLastMessage('assistant', 'Cancelled.');
				if (this._currentSessionId) {
					const session = this._sessions.get(this._currentSessionId);
					const last = session?.messages[session.messages.length - 1];
					if (!(last?.role === 'assistant' && /Cancelled/i.test(last.content))) {
						await this._sessions.appendMessage(this._currentSessionId, 'assistant', 'Cancelled.');
					}
					await this._sessions.updateState(this._currentSessionId, 'cancelled');
				}
			} else {
				this.updateLastMessage('assistant', `Error: ${message}`);
				if (this._currentSessionId) {
					await this._sessions.appendMessage(
						this._currentSessionId,
						'assistant',
						`Error: ${message}`
					);
					await this._sessions.updateState(this._currentSessionId, 'failed');
				}
			}
		} finally {
			this._abort = undefined;
			this._pendingImages = [];
			this._running = false;
			this.updateView();
			await this.drainQueue();
		}
	}

	private enqueueMessage(text: string, mode?: AgentMode): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this._queue.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			text: trimmed,
			mode,
		});
		this.pushQueue();
	}

	private removeQueued(id: string): void {
		this._queue = this._queue.filter(item => item.id !== id);
		this.pushQueue();
	}

	private pushQueue(): void {
		this._view?.webview.postMessage({
			type: 'queue',
			items: this._queue.map(item => ({ id: item.id, text: item.text })),
			running: this._running,
		});
	}

	private async drainQueue(): Promise<void> {
		const next = this._queue.shift();
		this.pushQueue();
		if (!next) return;
		await this.runTask(next.text, next.mode);
	}

	async cancelTask() {
		this._cancelled = true;
		this._abort?.abort();
		try {
			this._bridge.abortRunningShells();
		} catch {
			/* ignore */
		}
		vscode.window.showInformationMessage('Task cancelled');
		this.updateLastMessage('assistant', 'Cancelled.');
		this.pushActivity({
			kind: 'checkpoint',
			label: 'Stopped',
			detail: 'User cancelled',
		});
		if (this._currentSessionId) {
			const session = this._sessions.get(this._currentSessionId);
			const last = session?.messages[session.messages.length - 1];
			if (!(last?.role === 'assistant' && last.content === 'Cancelled.')) {
				await this._sessions.appendMessage(this._currentSessionId, 'assistant', 'Cancelled.');
			}
			await this._sessions.updateState(this._currentSessionId, 'cancelled');
		}
		this.updateView();
	}

	private async pickAttachments(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: 'Attach to Agent',
		});
		if (!uris?.length) return;
		const next = await attachmentsFromUris(uris);
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, next);
		this.pushConfig();
	}

	private async attachFromUriList(uriList: string): Promise<void> {
		const uris = parseDroppedUriList(uriList);
		if (!uris.length) return;
		const next = await attachmentsFromUris(uris);
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, next);
		this.pushConfig();
	}

	private async attachFromBlobs(
		blobs: Array<{ name: string; mime?: string; base64: string }>
	): Promise<void> {
		const next: PendingAttachment[] = [];
		for (const blob of blobs.slice(0, 8)) {
			const att = attachmentFromBlob(blob);
			if (att) next.push(att);
		}
		if (!next.length) return;
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, next);
		this.pushConfig();
	}

	private attachHttpUrl(url: string): void {
		if (!isHttpUrl(url)) return;
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, [
			attachmentFromHttpUrl(url),
		]);
		this.pushConfig();
	}

	private async setMode(mode: AgentMode) {
		this._mode = mode;
		await vscode.workspace
			.getConfiguration('codeforge.ai')
			.update('mode', this._mode, vscode.ConfigurationTarget.Global);
		if (mode !== 'auto') {
			try {
				getApprovalPolicy().clearSession();
			} catch {
				/* ignore */
			}
		}
		try {
			this._permissions = getApprovalPolicy().getPermissionLevel(this._mode);
		} catch {
			this._permissions = mode === 'auto' ? 'allowAll' : this._permissions === 'assisted' ? 'assisted' : 'default';
		}
		this.pushConfig();
	}

	private async setPermissions(level: Permissions) {
		try {
			const nextMode = await getApprovalPolicy().applyPermissionLevel(level);
			this._permissions = level;
			await this.setMode(nextMode);
		} catch (err) {
			vscode.window.showWarningMessage(
				`Could not set permissions: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		this.pushConfig();
	}

	async runGenerateInstructions(): Promise<void> {
		this.addMessage('user', '/instructions');
		this.addMessage('assistant', 'Generating AGENTS.md…', 'pending');
		try {
			const result = await generateAgentsMd({
				bridge: this._bridge,
				store: this._store,
				abortSignal: this._abort?.signal,
			});
			this._hasAgentsMd = true;
			this.updateLastMessage(
				'assistant',
				result.created
					? `Created ${result.path}. The agent will use these project instructions on the next turn.`
					: `Kept existing ${result.path}.`
			);
			this.pushConfig();
		} catch (err) {
			this.updateLastMessage(
				'assistant',
				`Could not generate AGENTS.md: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private getModelLabel(): string {
		const { server, model } = this._store.getActiveSelection();
		if (server && model) {
			return `${server.name} · ${model}`;
		}
		if (server) {
			return `${server.name} · add a model`;
		}
		return 'Add server in Settings';
	}

	private detectWeakHarness(server: { baseUrl?: string; numCtx?: number } | null | undefined, model: string | null | undefined): boolean {
		const mode = resolveWeakModelMode(
			vscode.workspace.getConfiguration('codeforge.ai').get<string>('weakModelMode')
		);
		return isWeakModel(
			{ modelId: model, baseUrl: server?.baseUrl, numCtx: server?.numCtx },
			mode
		);
	}

	private pushConfig() {
		if (!this._view) return;
		const { server, model } = this._store.getActiveSelection();
		const configured = Boolean(server);
		this._weakHarness = this.detectWeakHarness(server, model);
		this._view.description = this.getModelLabel();
		this._view.webview.postMessage({
			type: 'config',
			mode: this._mode,
			permissions: this._permissions,
			provider: server?.kind ?? '',
			model: model ?? '',
			serverName: server?.name ?? '',
			configured,
			hasKey: configured,
			workspace: this._bridge.getWorkspaceRoot() ?? null,
			badge: this._contextBadge,
			hasAgentsMd: this._hasAgentsMd,
			weakHarness: this._weakHarness,
			slashCommands: SLASH_COMMANDS,
			attachments: this._pendingAttachments.map(a => ({
				id: a.id,
				label: a.label,
				kind: a.kind,
			})),
		});
	}

	private pushActivity(event: AgentActivityEvent) {
		if (event.kind === 'tool' && event.toolCallId) {
			const existing = this._timeline.find(
				t => t.kind === 'tool' && t.toolCallId === event.toolCallId
			);
			if (existing) {
				existing.label = event.label;
				existing.detail = event.detail;
				existing.success = event.success;
				existing.toolStatus = event.toolStatus;
				existing.ts = Date.now();
				this.updateView();
				return;
			}
		}
		const item: TimelineItem = {
			id: event.toolCallId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			kind: event.kind,
			label: event.label,
			detail: event.detail,
			tool: event.tool,
			success: event.success,
			toolCallId: event.toolCallId,
			toolStatus: event.toolStatus,
			ts: Date.now(),
		};
		this._timeline.push(item);
		if (this._timeline.length > 80) {
			this._timeline = this._timeline.slice(-80);
		}
		this.updateView();
	}

	private async executeLocalAgent(
		task: string,
		images: Array<{ mime: string; dataUrl: string; label?: string }> = []
	): Promise<string> {
		const root = this._bridge.getWorkspaceRoot();
		const { server, model } = this._store.getActiveSelection();

		if (!server) {
			return [
				`No AI server configured.`,
				`Workspace: ${root ?? '(none — open a folder)'}`,
				``,
				`Add a server in Settings (⚙) or Command Palette → CodeForge AI: Settings.`,
				`Then pick a model with the chip above.`,
			].join('\n');
		}

		const provider = server.kind;
		const apiKey = server.apiKey ?? '';
		const activeModel = model ?? server.models[0] ?? '';
		const baseUrl =
			server.baseUrl ||
			(provider === 'ollama' ? 'http://localhost:11434/v1' : '');

		if (!activeModel) {
			return [
				`Server "${server.name}" has no model selected.`,
				`Open Settings → add or fetch models, then pick one in the model chip.`,
			].join('\n');
		}

		if (this._mode === 'ask') {
			if (!apiKey && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
				return [
					`Ask mode — add an API key for ${server.name} in Settings.`,
					`Workspace: ${root ?? '(none)'}`,
				].join('\n');
			}
			return this.callLlm(
				task,
				provider,
				apiKey,
				root,
				false,
				activeModel,
				baseUrl,
				this.getHistoryForLlm(),
				images
			);
		}

		const weakProfile = this.detectWeakHarness(server, activeModel);
		this._weakHarness = weakProfile;
		this.pushConfig();

		if (this._mode === 'plan') {
			const cfgAgentPlan = vscode.workspace.getConfiguration('codeforge.ai');
			return runAgentWithTools({
				bridge: this._bridge,
				provider,
				apiKey,
				model: activeModel,
				baseUrl,
				workspaceRoot: root,
				task,
				images,
				history: this.getHistoryForLlm(),
				cancelled: () => this._cancelled,
				abortSignal: this._abort?.signal,
				numCtx: server.numCtx,
				forceJson: server.forceJson === true,
				onStatus: text => {
					if (/^Running\s/i.test(text)) {
						return;
					}
					this.updateLastMessage('assistant', text, 'pending');
				},
				onActivity: ev => this.pushActivity(ev),
				onContextBadge: badge => {
					this._contextBadge = badge;
					this.pushConfig();
				},
				onTaskUpdate: this._onTaskUpdate,
				sessionStore: this._sessions,
				sessionId: this._currentSessionId,
				maxSteps: cfgAgentPlan.get<number>('agentCheckpointSteps') ?? 20,
				hardCap: cfgAgentPlan.get<number>('agentHardCap') ?? 100,
				weakProfile,
				planMode: true,
			});
		}

		const lower = task.toLowerCase();
		if (lower.includes('list') && (lower.includes('file') || lower.includes('dir') || lower.includes('pasta'))) {
			const result = await this._bridge.execute({
				id: '1',
				name: 'list',
				arguments: { path: '.', recursive: false },
			});
			return `Workspace: ${root ?? '(none)'}\n\n${result.output}`;
		}

		if (lower.startsWith('read ') || lower.startsWith('abrir ') || lower.startsWith('open ')) {
			const filePath = task.split(/\s+/).slice(1).join(' ').trim().replace(/^["']|["']$/g, '');
			const result = await this._bridge.execute({
				id: '2',
				name: 'read',
				arguments: { path: filePath },
			});
			if (!result.success) {
				return `Could not read ${filePath}: ${result.error}`;
			}
			return `Contents of ${filePath}:\n\n\`\`\`\n${result.output}\n\`\`\``;
		}

		if (lower.startsWith('search ') || lower.startsWith('buscar ') || lower.startsWith('find ')) {
			const pattern = task.split(/\s+/).slice(1).join(' ').trim();
			const result = await this._bridge.execute({
				id: '3',
				name: 'search',
				arguments: { pattern },
			});
			return result.output;
		}

		if (!apiKey && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
			return [
				`Server "${server.name}" needs an API key.`,
				`Open Settings (⚙) → enter the key → Save.`,
				``,
				`Without a key you can still try:`,
				`· list files`,
				`· read README.md`,
				`· search TODO`,
			].join('\n');
		}

		const cfgAgent = vscode.workspace.getConfiguration('codeforge.ai');
		return runAgentWithTools({
			bridge: this._bridge,
			provider,
			apiKey,
			model: activeModel,
			baseUrl,
			workspaceRoot: root,
			task,
			images,
			history: this.getHistoryForLlm(),
			cancelled: () => this._cancelled,
			abortSignal: this._abort?.signal,
			numCtx: server.numCtx,
			forceJson: server.forceJson === true,
			onStatus: text => {
				// Tool progress uses tool cards — keep pending bubble for thinking/checkpoints only.
				if (/^Running\s/i.test(text)) {
					return;
				}
				this.updateLastMessage('assistant', text, 'pending');
			},
			onActivity: ev => this.pushActivity(ev),
			onContextBadge: badge => {
				this._contextBadge = badge;
				this.pushConfig();
			},
			onTaskUpdate: this._onTaskUpdate,
			sessionStore: this._sessions,
			sessionId: this._currentSessionId,
			maxSteps: cfgAgent.get<number>('agentCheckpointSteps') ?? 20,
			hardCap: cfgAgent.get<number>('agentHardCap') ?? 100,
			weakProfile,
		});
	}

	private _onTaskUpdate?: (update: {
		id: string;
		name: string;
		status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
		model?: string;
		elapsed?: number;
		result?: string;
		subtasks?: Array<{
			id: string;
			name: string;
			status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
		}>;
	}) => void;

	setTaskUpdateHandler(handler: NonNullable<ChatViewProvider['_onTaskUpdate']>): void {
		this._onTaskUpdate = handler;
	}

	private getHistoryForLlm(): Array<{ role: 'user' | 'assistant'; content: string }> {
		const completed = this._messages.filter(m => m.status !== 'pending');
		const prior = completed.slice(0, -1);
		return prior.slice(-16).map(m => ({
			role: m.role,
			content: truncateForLlmHistory(m.content),
		}));
	}

	private async callLlm(
		task: string,
		provider: string,
		apiKey: string,
		root: string | undefined,
		_tools: boolean,
		model: string,
		baseUrl: string,
		history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
		images: Array<{ mime: string; dataUrl: string; label?: string }> = []
	): Promise<string> {
		const resolvedBase =
			baseUrl ||
			(provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1');

		const systemBase = `You are CodeForge Ask mode. Answer questions about the workspace (${root ?? 'none'}) without proposing to run tools. Be concise. Use prior conversation context when the user says continue. Analyze attached images or links when present.`;
		const agents = await loadAgentsMdForPrompt();
		const system = agents ? `${systemBase}\n\n${agents}` : systemBase;

		if (provider === 'anthropic') {
			return this.callAnthropic(task, apiKey, model, system, history, images);
		}

		const userContent =
			images.length === 0
				? task
				: [
						{ type: 'text', text: task },
						...images.map(img => ({
							type: 'image_url',
							image_url: { url: img.dataUrl },
						})),
					];

		const url = `${resolvedBase.replace(/\/$/, '')}/chat/completions`;
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			signal: this._abort?.signal,
			body: JSON.stringify({
				model: provider === 'ollama' ? model || 'llama3.2' : model,
				messages: [
					{ role: 'system', content: system },
					...history,
					{ role: 'user', content: userContent },
				],
				temperature: 0.2,
				stream: false,
				max_tokens: 2048,
			}),
		});

		if (!response.ok) {
			throw new Error(`LLM error ${response.status}: ${await response.text()}`);
		}

		const raw = await response.text();
		const trimmed = raw.trim();
		if (trimmed.startsWith('data:') || trimmed.startsWith(':')) {
			let content = '';
			for (const line of trimmed.split(/\r?\n/)) {
				const t = line.trim();
				if (!t.startsWith('data:')) continue;
				const payload = t.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				try {
					const chunk = JSON.parse(payload) as {
						choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
					};
					content += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
				} catch {
					/* skip */
				}
			}
			return content || '(empty response)';
		}
		const data = JSON.parse(raw) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		return data.choices?.[0]?.message?.content ?? '(empty response)';
	}

	private async callAnthropic(
		task: string,
		apiKey: string,
		model: string,
		system: string,
		history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
		images: Array<{ mime: string; dataUrl: string; label?: string }> = []
	): Promise<string> {
		const userContent =
			images.length === 0
				? task
				: [
						{ type: 'text', text: task },
						...images.map(img => {
							const m = /^data:([^;]+);base64,(.+)$/i.exec(img.dataUrl);
							if (m) {
								return {
									type: 'image',
									source: { type: 'base64', media_type: m[1], data: m[2] },
								};
							}
							return { type: 'image', source: { type: 'url', url: img.dataUrl } };
						}),
					];

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			signal: this._abort?.signal,
			body: JSON.stringify({
				model: model.includes('claude') ? model : 'claude-3-5-sonnet-20241022',
				max_tokens: 1024,
				system,
				messages: [...history, { role: 'user', content: userContent }],
			}),
		});

		if (!response.ok) {
			throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
		}

		const data = (await response.json()) as {
			content?: Array<{ type: string; text?: string }>;
		};
		return data.content?.find(c => c.type === 'text')?.text ?? '(empty response)';
	}

	private async handleUserMessage(text: string, mode?: AgentMode) {
		const slash = parseSlashInput(text);
		if (slash) {
			const handled = await this.dispatchSlash(slash.command, slash.args);
			if (handled) return;
		}
		await this.runTask(text, mode);
	}

	private async dispatchSlash(command: string, _args: string): Promise<boolean> {
		switch (command) {
			case 'help':
				this.addMessage('user', '/help');
				this.addMessage('assistant', formatSlashHelp());
				return true;
			case 'clear':
				this.newChat();
				return true;
			case 'ask':
				await this.setMode('ask');
				this.addMessage('user', '/ask');
				this.addMessage('assistant', 'Switched to Ask mode.');
				return true;
			case 'plan':
				await this.setMode('plan');
				this.addMessage('user', '/plan');
				this.addMessage(
					'assistant',
					'Switched to Plan mode — explore the repo and save a wiki task-plan (no implementation writes).'
				);
				return true;
			case 'agent':
				await this.setPermissions('default');
				this.addMessage('user', '/agent');
				this.addMessage('assistant', 'Switched to Agent mode (Default permissions).');
				return true;
			case 'auto':
				await this.setPermissions('allowAll');
				this.addMessage('user', '/auto');
				this.addMessage('assistant', 'Switched to Auto mode (Allow all this session).');
				return true;
			case 'permissions': {
				const next = getApprovalPolicy().cyclePermissionLevel(this._permissions);
				await this.setPermissions(next);
				this.addMessage('user', '/permissions');
				this.addMessage(
					'assistant',
					`Permissions: ${next === 'allowAll' ? 'Allow all' : next === 'assisted' ? 'Assisted' : 'Default'}.`
				);
				return true;
			}
			case 'instructions':
				await this.runGenerateInstructions();
				return true;
			default:
				this.addMessage('user', `/${command}`);
				this.addMessage(
					'assistant',
					`Unknown command /${command}. Try /help for the list.`
				);
				return true;
		}
	}

	private addMessage(role: 'user' | 'assistant', content: string, status?: string) {
		this._messages.push({ role, content, status, timestamp: new Date() });
		this.updateView();
	}

	private updateLastMessage(role: 'user' | 'assistant', content: string, status?: string) {
		const lastIndex = this._messages.length - 1;
		if (lastIndex >= 0 && this._messages[lastIndex].role === role) {
			this._messages[lastIndex].content = content;
			this._messages[lastIndex].status = status;
		}
		this.updateView();
	}

	private updateView() {
		if (this._view) {
			const collapseToolCards =
				vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('collapseToolCards') !==
				false;
			this._view.webview.postMessage({
				type: 'updateMessages',
				messages: this._messages,
				timeline: this._timeline,
				collapseToolCards,
			});
		}
	}

	private _getHtmlContent(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CodeForge AI</title>
<style>
  :root { --gap: 8px; --radius: 8px; }
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  body { display: flex; flex-direction: column; padding: 0; }
  .topbar {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0;
  }
  .modes {
    display: inline-flex; background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 999px; padding: 2px;
  }
  .modes button {
    border: 0; background: transparent; color: var(--vscode-descriptionForeground);
    padding: 4px 8px; border-radius: 999px; cursor: pointer; font: inherit;
  }
  .modes button.active {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .spacer { flex: 1; }
  .chip, .icon-btn {
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background);
    color: var(--vscode-foreground); border-radius: 999px; padding: 4px 10px;
    font: inherit; cursor: pointer; max-width: 160px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .icon-btn {
    width: 28px; height: 28px; padding: 0; display: grid; place-items: center; border-radius: 6px;
  }
  .badge {
    font-size: 0.72em; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 8px;
    max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .messages {
    flex: 1; overflow-y: auto; padding: 12px 10px 8px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .empty {
    margin: auto; text-align: center; color: var(--vscode-descriptionForeground);
    max-width: 300px; line-height: 1.45;
  }
  .empty h1 { font-size: 1.15rem; font-weight: 600; color: var(--vscode-foreground); margin: 0 0 8px; }
  .empty .sparkle { font-size: 1.6rem; margin-bottom: 6px; opacity: 0.9; }
  .empty .cta-row { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
  .empty .cta {
    border: 0; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .empty .cta.secondary {
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border);
  }
  .empty .disclaimer { font-size: 0.78em; margin-top: 10px; opacity: 0.85; }
  .empty kbd {
    font-family: var(--vscode-editor-font-family); font-size: 0.85em;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 1px 5px;
    background: var(--vscode-input-background);
  }
  .msg {
    padding: 0; border-radius: 0; line-height: 1.45; border: 0; max-width: 100%;
  }
  .msg.user {
    align-self: flex-end;
    max-width: min(92%, 520px);
    margin: 2px 0 6px;
  }
  .msg.user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 14px;
    padding: 10px 14px;
    box-shadow: 0 1px 0 color-mix(in srgb, var(--vscode-widget-shadow, #000) 12%, transparent);
  }
  .msg.assistant {
    align-self: stretch;
    background: transparent;
    border: 0;
    padding: 4px 2px 10px;
    max-width: 100%;
  }
  .msg.pending { opacity: 0.85; }
  .role {
    font-size: 0.72em; color: var(--vscode-descriptionForeground);
    margin-bottom: 4px; letter-spacing: 0.02em;
  }
  .msg.user .role { display: none; }
  .msg-body { word-wrap: break-word; overflow-wrap: anywhere; }
  .msg.user .msg-body { white-space: pre-wrap; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0.55em 0; }
  .md h1, .md h2, .md h3, .md h4 {
    margin: 0.85em 0 0.35em; font-weight: 600; line-height: 1.3;
    color: var(--vscode-foreground);
  }
  .md h1 { font-size: 1.2em; }
  .md h2 { font-size: 1.1em; }
  .md h3, .md h4 { font-size: 1em; }
  .md ul, .md ol { margin: 0.4em 0; padding-left: 1.35em; }
  .md li { margin: 0.15em 0; }
  .md li::marker { color: var(--vscode-descriptionForeground); }
  .md blockquote {
    margin: 0.5em 0; padding: 0.15em 0 0.15em 0.75em;
    border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .md hr {
    border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 0.75em 0;
  }
  .md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .md a:hover { text-decoration: underline; }
  .md code {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 0.05em 0.35em;
  }
  .md pre {
    margin: 0.55em 0; padding: 8px 10px; overflow: auto; max-height: 280px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  }
  .md pre code {
    border: 0; background: transparent; padding: 0; font-size: 0.85em;
    white-space: pre;
  }
  .md strong { font-weight: 600; }
  .msg-meta {
    margin-top: 8px; border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 4px 8px;
    background: var(--vscode-input-background);
  }
  .msg-meta summary {
    cursor: pointer; font-size: 0.78em; color: var(--vscode-descriptionForeground);
    list-style: none;
  }
  .msg-meta summary::-webkit-details-marker { display: none; }
  .msg-meta pre {
    margin: 6px 0 2px; white-space: pre-wrap; font-size: 0.78em;
    color: var(--vscode-descriptionForeground); max-height: 160px; overflow: auto;
  }
  .timeline {
    border: 1px solid var(--vscode-panel-border); border-radius: var(--radius);
    padding: 6px 8px; background: var(--vscode-input-background); align-self: stretch;
  }
  .timeline summary {
    cursor: pointer; font-size: 0.8em; color: var(--vscode-descriptionForeground);
    list-style: none; display: flex; align-items: center; gap: 6px;
  }
  .timeline summary::-webkit-details-marker { display: none; }
  .tl-item {
    margin-top: 6px; padding: 6px 8px; border-left: 2px solid var(--vscode-panel-border);
    font-size: 0.8em; line-height: 1.35;
  }
  .tl-item.thought { border-left-color: var(--vscode-charts-yellow, #cca700); }
  .tl-item.tool { border-left-color: var(--vscode-charts-blue, #3794ff); }
  .tl-item.compact { border-left-color: var(--vscode-charts-purple, #b180d7); }
  .tl-item.checkpoint, .tl-item.context { border-left-color: var(--vscode-charts-green, #89d185); }
  .tl-label { font-weight: 600; }
  .tl-detail {
    margin-top: 4px; color: var(--vscode-descriptionForeground); white-space: pre-wrap;
    max-height: 120px; overflow: auto;
  }
  .tool-stream {
    align-self: stretch; display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px;
  }
  .tool-card {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-editor-background); font-size: 0.82em;
  }
  .tool-card summary {
    list-style: none; cursor: pointer; padding: 8px 10px; display: flex; gap: 8px; align-items: center;
  }
  .tool-card summary::-webkit-details-marker { display: none; }
  .tool-card .badge {
    font-size: 0.75em; padding: 1px 6px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .tool-card.running .badge { opacity: 0.85; }
  .tool-card.ok .badge { background: var(--vscode-testing-iconPassed, #73c991); color: #000; }
  .tool-card.failed .badge { background: var(--vscode-testing-iconFailed, #f14c4c); color: #fff; }
  .tool-card .body {
    padding: 0 10px 8px; color: var(--vscode-descriptionForeground);
    white-space: pre-wrap; max-height: 160px; overflow: auto; border-top: 1px solid var(--vscode-panel-border);
  }
  .composer {
    flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border);
    padding: 10px; display: flex; flex-direction: column; gap: 8px;
    background: var(--vscode-sideBar-background);
  }
  .composer-box {
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background); border-radius: 10px; padding: 8px 10px 6px;
    position: relative;
  }
  .composer-box.drag-over {
    outline: 2px dashed var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  .drop-hint {
    display: none; position: absolute; inset: 0; border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    align-items: center; justify-content: center; font-size: 0.85em;
    color: var(--vscode-foreground); pointer-events: none; z-index: 2;
  }
  .composer-box.drag-over .drop-hint { display: flex; }
  textarea {
    width: 100%; min-height: 56px; max-height: 160px; resize: vertical; border: 0;
    outline: none; background: transparent; color: var(--vscode-input-foreground);
    font: inherit; line-height: 1.4;
  }
  .attach-row {
    display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px;
  }
  .attach-chip {
    font-size: 0.72em; border: 1px solid var(--vscode-panel-border);
    border-radius: 999px; padding: 2px 8px; color: var(--vscode-descriptionForeground);
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  }
  .attach-chip .kind { opacity: 0.7; }
  .attach-chip button {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    padding: 0 2px; font: inherit; line-height: 1;
  }
  .composer-actions { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.75em; flex: 1; min-width: 80px; }
  .perm-chip {
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background);
    color: var(--vscode-foreground); border-radius: 999px; padding: 3px 10px;
    font: inherit; font-size: 0.78em; cursor: pointer;
  }
  .slash-menu {
    display: none; position: absolute; left: 8px; right: 8px; bottom: 100%;
    margin-bottom: 4px; max-height: 180px; overflow: auto; z-index: 5;
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  }
  .slash-menu.open { display: block; }
  .slash-item {
    display: flex; gap: 8px; padding: 7px 10px; cursor: pointer; font-size: 0.85em;
  }
  .slash-item:hover, .slash-item.active { background: var(--vscode-list-hoverBackground); }
  .slash-item .name { font-weight: 600; min-width: 100px; }
  .slash-item .desc { color: var(--vscode-descriptionForeground); }
  .send, .stop {
    border: 0; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer;
  }
  .send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-errorForeground, #f48771); display: none; }
  .send:disabled { opacity: 0.5; cursor: default; }
  body.busy .stop { display: inline-block; }
  .queue-panel {
    display: none; flex-direction: column; gap: 6px;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 8px; background: var(--vscode-input-background);
  }
  .queue-panel.visible { display: flex; }
  .queue-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.78em; color: var(--vscode-descriptionForeground);
  }
  .queue-head strong { color: var(--vscode-foreground); font-weight: 600; }
  .queue-head .spacer { flex: 1; }
  .queue-head button {
    border: 0; background: transparent; color: var(--vscode-textLink-foreground);
    cursor: pointer; font: inherit; font-size: 0.95em; padding: 0;
  }
  .queue-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 6px 8px; border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent);
    border: 1px solid var(--vscode-panel-border);
    font-size: 0.82em; line-height: 1.35;
  }
  .queue-item .idx {
    color: var(--vscode-descriptionForeground); min-width: 1.2em; flex-shrink: 0;
  }
  .queue-item .qtext {
    flex: 1; white-space: pre-wrap; word-break: break-word;
    max-height: 3.6em; overflow: hidden;
  }
  .queue-item button {
    border: 0; background: transparent; color: var(--vscode-descriptionForeground);
    cursor: pointer; font: inherit; line-height: 1; padding: 0 2px; flex-shrink: 0;
  }
  .queue-item button:hover { color: var(--vscode-errorForeground, #f48771); }
</style>
</head>
<body>
  <div class="topbar">
    <div class="modes" role="tablist">
      <button type="button" id="modeAgent" class="active" data-mode="agent">Agent</button>
      <button type="button" id="modePlan" data-mode="plan">Plan</button>
      <button type="button" id="modeAsk" data-mode="ask">Ask</button>
      <button type="button" id="modeAuto" data-mode="auto">Auto</button>
    </div>
    <div class="spacer"></div>
    <span class="badge" id="weakBadge" title="Weak-model harness active" style="display:none">Weak harness</span>
    <span class="badge" id="contextBadge" title="Indexed paths · in context">0 · 0</span>
    <button type="button" class="chip" id="modelChip" title="Switch model">model</button>
    <button type="button" class="icon-btn" id="settingsBtn" title="Settings">⚙</button>
    <button type="button" class="icon-btn" id="newChatBtn" title="New chat">＋</button>
  </div>

  <div class="messages" id="messages">
    <div class="empty" id="emptyState">
      <div class="sparkle">✦</div>
      <h1>Build with Agent</h1>
      <p>Plan, edit, and verify across your workspace.</p>
      <div class="cta-row">
        <button type="button" class="cta" id="ctaStart">Start building</button>
        <button type="button" class="cta secondary" id="ctaInstructions">Generate Agent Instructions</button>
      </div>
      <p class="disclaimer">AI responses may be inaccurate. Press <kbd>Ctrl</kbd>+<kbd>L</kbd> to focus.</p>
    </div>
  </div>

  <div class="composer">
    <div class="queue-panel" id="queuePanel" aria-live="polite">
      <div class="queue-head">
        <strong>Queue</strong>
        <span id="queueCount">0</span>
        <span class="spacer"></span>
        <button type="button" id="clearQueueBtn">Clear</button>
      </div>
      <div id="queueList"></div>
    </div>
    <div class="composer-box" id="composerBox">
      <div class="drop-hint">Drop files, images, or links</div>
      <div class="slash-menu" id="slashMenu"></div>
      <div class="attach-row" id="attachRow"></div>
      <textarea id="messageInput" placeholder="Plan, search, edit… Type / for commands. Enter to send"></textarea>
      <div class="composer-actions">
        <button type="button" class="icon-btn" id="attachBtn" title="Attach files">📎</button>
        <button type="button" class="perm-chip" id="permChip" title="Permissions">Default</button>
        <span class="hint" id="modeHint">Agent can use workspace tools</span>
        <button class="stop" id="stopButton" type="button">Stop</button>
        <button class="send" id="sendButton" type="button">Send</button>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let mode = 'agent';
  let permissions = 'default';
  let busy = false;
  let timeline = [];
  let collapseToolCards = true;
  let slashCommands = [];
  let hasAgentsMd = false;
  let slashOpen = false;
  let slashIndex = 0;
  let slashFiltered = [];

  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('messageInput');
  const sendButton = document.getElementById('sendButton');
  const stopButton = document.getElementById('stopButton');
  const modelChip = document.getElementById('modelChip');
  const modeHint = document.getElementById('modeHint');
  const modeAgent = document.getElementById('modeAgent');
  const modePlan = document.getElementById('modePlan');
  const modeAsk = document.getElementById('modeAsk');
  const modeAuto = document.getElementById('modeAuto');
  const weakBadge = document.getElementById('weakBadge');
  const contextBadge = document.getElementById('contextBadge');
  const attachRow = document.getElementById('attachRow');
  const composerBox = document.getElementById('composerBox');
  const permChip = document.getElementById('permChip');
  const slashMenu = document.getElementById('slashMenu');
  const queuePanel = document.getElementById('queuePanel');
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  let attachmentCount = 0;
  let queuedItems = [];

  function syncSendButton() {
    sendButton.disabled = false;
    sendButton.textContent = busy ? 'Queue' : 'Send';
    input.placeholder = busy
      ? 'Add to queue… Enter queues while Agent is working'
      : (mode === 'ask'
        ? 'Ask about the codebase… Type / for commands'
        : 'Plan, search, edit… Type / for commands');
  }

  function renderQueue(items) {
    queuedItems = Array.isArray(items) ? items : [];
    queueCount.textContent = String(queuedItems.length);
    queuePanel.classList.toggle('visible', queuedItems.length > 0);
    queueList.innerHTML = queuedItems.map(function (item, i) {
      return '<div class="queue-item" data-id="' + escapeHtml(item.id) + '">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="qtext">' + escapeHtml(item.text) + '</span>' +
        '<button type="button" title="Remove from queue">×</button>' +
        '</div>';
    }).join('');
    queueList.querySelectorAll('.queue-item button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const row = btn.closest('.queue-item');
        const id = row && row.getAttribute('data-id');
        if (id) vscode.postMessage({ type: 'removeQueued', id: id });
      });
    });
  }

  function permLabel(p) {
    return p === 'allowAll' ? 'Allow all' : p === 'assisted' ? 'Assisted' : 'Default';
  }

  function syncPermChip() {
    permChip.textContent = permLabel(permissions);
  }

  function setMode(next) {
    mode = next === 'ask' ? 'ask' : next === 'plan' ? 'plan' : next === 'auto' ? 'auto' : 'agent';
    modeAgent.classList.toggle('active', mode === 'agent');
    if (modePlan) modePlan.classList.toggle('active', mode === 'plan');
    modeAsk.classList.toggle('active', mode === 'ask');
    modeAuto.classList.toggle('active', mode === 'auto');
    modeHint.textContent = mode === 'ask'
      ? 'Ask answers without running tools'
      : mode === 'plan'
        ? 'Plan: explore + wiki plan only (no code writes)'
      : mode === 'auto'
        ? 'Auto-approves edits + shell this session'
        : permissions === 'assisted'
          ? 'Agent with edit preview'
          : 'Agent can use workspace tools';
    input.placeholder = busy
      ? 'Add to queue… Enter queues while Agent is working'
      : (mode === 'ask'
        ? 'Ask about the codebase… Type / for commands'
        : mode === 'plan'
          ? 'Describe the feature to plan… Type / for commands'
        : 'Plan, search, edit… Type / for commands');
    vscode.postMessage({ type: 'setMode', mode });
  }

  modeAgent.addEventListener('click', () => setMode('agent'));
  if (modePlan) modePlan.addEventListener('click', () => setMode('plan'));
  modeAsk.addEventListener('click', () => setMode('ask'));
  modeAuto.addEventListener('click', () => setMode('auto'));
	modelChip.addEventListener('click', () => {
    if (!modelChip.textContent || modelChip.textContent.indexOf('Add server') >= 0) {
      vscode.postMessage({ type: 'openSettings' });
    } else {
      vscode.postMessage({ type: 'configure' });
    }
  });
  document.getElementById('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  document.getElementById('newChatBtn').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  document.getElementById('attachBtn').addEventListener('click', () => vscode.postMessage({ type: 'attachFiles' }));
  stopButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  permChip.addEventListener('click', () => {
    const order = ['default', 'assisted', 'allowAll'];
    const i = order.indexOf(permissions);
    const next = order[(i + 1) % order.length];
    vscode.postMessage({ type: 'setPermissions', level: next });
  });
  document.getElementById('ctaStart').addEventListener('click', () => {
    vscode.postMessage({ type: 'emptyCta', action: 'start' });
  });
  document.getElementById('ctaInstructions').addEventListener('click', () => {
    vscode.postMessage({ type: 'emptyCta', action: 'instructions' });
  });

  function sendMessage() {
    const text = input.value.trim();
    if (!text && attachmentCount === 0) return;
    hideSlash();
    vscode.postMessage({ type: 'sendMessage', text: text || 'Analyze the attached items.', mode });
    input.value = '';
  }

  function filterSlash(prefix) {
    const q = prefix.replace(/^\\//, '').toLowerCase();
    if (!q) return slashCommands.slice();
    return slashCommands.filter(c => c.name.startsWith(q) || c.name.includes(q));
  }

  function renderSlash() {
    if (!slashOpen || !slashFiltered.length) {
      slashMenu.classList.remove('open');
      slashMenu.innerHTML = '';
      return;
    }
    slashMenu.innerHTML = slashFiltered.map((c, i) =>
      '<div class="slash-item' + (i === slashIndex ? ' active' : '') + '" data-i="' + i + '">' +
      '<span class="name">/' + escapeHtml(c.name) + '</span>' +
      '<span class="desc">' + escapeHtml(c.description || '') + '</span></div>'
    ).join('');
    slashMenu.classList.add('open');
    slashMenu.querySelectorAll('.slash-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applySlash(Number(el.getAttribute('data-i')));
      });
    });
  }

  function applySlash(i) {
    const c = slashFiltered[i];
    if (!c) return;
    input.value = '/' + c.name + ' ';
    hideSlash();
    input.focus();
  }

  function hideSlash() {
    slashOpen = false;
    slashMenu.classList.remove('open');
  }

  function updateSlashFromInput() {
    const val = input.value;
    const m = /^\\/([a-zA-Z0-9_-]*)$/.exec(val);
    if (m) {
      slashOpen = true;
      slashFiltered = filterSlash(m[1]);
      slashIndex = 0;
      renderSlash();
    } else {
      hideSlash();
    }
  }

  sendButton.addEventListener('click', sendMessage);
  input.addEventListener('input', updateSlashFromInput);
  input.addEventListener('keydown', (e) => {
    if (slashOpen && slashFiltered.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashFiltered.length;
        renderSlash();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashFiltered.length) % slashFiltered.length;
        renderSlash();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applySlash(slashIndex);
        return;
      }
      if (e.key === 'Escape') {
        hideSlash();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (slashOpen && slashFiltered.length && /^\\/[a-zA-Z0-9_-]*$/.test(input.value.trim())) {
        applySlash(slashIndex);
        return;
      }
      sendMessage();
    }
  });

  function collectUriList(dt) {
    const parts = [];
    const uriList = dt.getData('text/uri-list');
    if (uriList) parts.push(uriList);
    try {
      const resourceUrls = dt.getData('resourceurls');
      if (resourceUrls) {
        const arr = JSON.parse(resourceUrls);
        if (Array.isArray(arr)) parts.push(arr.map(decodeURIComponent).join('\\n'));
      }
    } catch (_) {}
    try {
      const codeList = dt.getData('application/vnd.code.uri-list');
      if (codeList) parts.push(codeList);
    } catch (_) {}
    const plain = dt.getData('text/plain');
    if (plain && /^https?:\\/\\//i.test(plain.trim())) {
      vscode.postMessage({ type: 'attachUrl', url: plain.trim() });
    }
    return parts.filter(Boolean).join('\\n');
  }

  function readFilesAsBlobs(fileList) {
    const files = Array.from(fileList || []).slice(0, 8);
    if (!files.length) return Promise.resolve([]);
    return Promise.all(files.map(file => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        const base64 = comma >= 0 ? result.slice(comma + 1) : result;
        resolve({ name: file.name, mime: file.type || undefined, base64 });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    }))).then(list => list.filter(Boolean));
  }

  ['dragenter', 'dragover'].forEach(ev => {
    composerBox.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      composerBox.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    composerBox.addEventListener(ev, (e) => {
      if (ev === 'dragleave' && e.target !== composerBox) return;
      composerBox.classList.remove('drag-over');
    });
  });
  composerBox.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    composerBox.classList.remove('drag-over');
    const dt = e.dataTransfer;
    if (!dt) return;
    const uriList = collectUriList(dt);
    if (uriList) vscode.postMessage({ type: 'attachUris', uriList });
    if (dt.files && dt.files.length) {
      const blobs = await readFilesAsBlobs(dt.files);
      if (blobs.length) vscode.postMessage({ type: 'attachBlobs', blobs });
    }
  });

  input.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      const blobs = await readFilesAsBlobs(files);
      if (blobs.length) vscode.postMessage({ type: 'attachBlobs', blobs });
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text && /^https?:\\/\\/\\S+$/i.test(text.trim()) && !input.value) {
      e.preventDefault();
      vscode.postMessage({ type: 'attachUrl', url: text.trim() });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'focusInput') {
      input.focus();
    }
    if (msg.type === 'config') {
      mode = msg.mode === 'ask' ? 'ask' : msg.mode === 'plan' ? 'plan' : msg.mode === 'auto' ? 'auto' : 'agent';
      permissions = msg.permissions === 'assisted' || msg.permissions === 'allowAll' ? msg.permissions : 'default';
      slashCommands = msg.slashCommands || [];
      hasAgentsMd = !!msg.hasAgentsMd;
      modeAgent.classList.toggle('active', mode === 'agent');
      if (modePlan) modePlan.classList.toggle('active', mode === 'plan');
      modeAsk.classList.toggle('active', mode === 'ask');
      modeAuto.classList.toggle('active', mode === 'auto');
      if (weakBadge) weakBadge.style.display = msg.weakHarness ? '' : 'none';
      syncPermChip();
      modelChip.textContent = msg.configured
        ? ((msg.serverName || msg.provider || 'server') + (msg.model ? ' · ' + msg.model : ' · add a model'))
        : 'Add server in Settings';
      modelChip.title = msg.configured ? 'Switch model' : 'Open Settings to add a server';
      modeHint.textContent = !msg.configured
        ? 'Open Settings (⚙) to add a server'
        : mode === 'ask'
          ? 'Ask answers without running tools'
          : mode === 'plan'
            ? 'Plan: explore + wiki plan only (no code writes)'
          : mode === 'auto'
            ? 'Auto-approves edits + shell this session'
            : (permissions === 'assisted' ? 'Agent with edit preview' : 'Agent can use workspace tools');
      if (msg.badge) {
        contextBadge.textContent = (msg.badge.indexed || 0) + ' indexed · ' + (msg.badge.inContext || 0) + ' in context';
      }
      const atts = msg.attachments || [];
      attachmentCount = atts.length;
      attachRow.innerHTML = atts.map(a => {
        const label = typeof a === 'string' ? a : (a.label || a.id || 'file');
        const id = typeof a === 'string' ? '' : (a.id || '');
        const kind = typeof a === 'string' ? '' : (a.kind || '');
        const kindMark = kind === 'image' ? '🖼 ' : kind === 'uri' ? '🔗 ' : '';
        return '<span class="attach-chip" title="' + escapeHtml(label) + '">' +
          '<span class="kind">' + kindMark + '</span>' +
          '<span>' + escapeHtml(label) + '</span>' +
          (id ? '<button type="button" data-id="' + escapeHtml(id) + '" title="Remove">×</button>' : '') +
          '</span>';
      }).join('');
      attachRow.querySelectorAll('button[data-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'removeAttachment', id: btn.getAttribute('data-id') });
        });
      });
    }
    if (msg.type === 'timeline') {
      timeline = msg.items || [];
    }
    if (msg.type === 'queue') {
      renderQueue(msg.items || []);
      if (typeof msg.running === 'boolean') {
        busy = msg.running || busy;
        document.body.classList.toggle('busy', busy);
        syncSendButton();
      }
    }
    if (msg.type === 'updateMessages') {
      if (msg.timeline) timeline = msg.timeline;
      if (typeof msg.collapseToolCards === 'boolean') {
        collapseToolCards = msg.collapseToolCards;
      }
      renderMessages(msg.messages || []);
      busy = (msg.messages || []).some(m => m.status === 'pending');
      document.body.classList.toggle('busy', busy);
      syncSendButton();
    }
  });

  function emptyHtml() {
    const instrBtn = hasAgentsMd
      ? '<button type="button" class="cta secondary" id="ctaInstructions">Update Agent Instructions</button>'
      : '<button type="button" class="cta secondary" id="ctaInstructions">Generate Agent Instructions</button>';
    return '<div class="empty" id="emptyState">' +
      '<div class="sparkle">✦</div>' +
      '<h1>Build with Agent</h1>' +
      '<p>Plan, edit, and verify across your workspace.</p>' +
      '<div class="cta-row">' +
      '<button type="button" class="cta" id="ctaStart">Start building</button>' +
      instrBtn +
      '</div>' +
      '<p class="disclaimer">AI responses may be inaccurate. Press <kbd>Ctrl</kbd>+<kbd>L</kbd> to focus. Tip: /instructions</p>' +
      '</div>';
  }

  function bindEmptyCtas() {
    const start = document.getElementById('ctaStart');
    const instr = document.getElementById('ctaInstructions');
    if (start) start.addEventListener('click', () => vscode.postMessage({ type: 'emptyCta', action: 'start' }));
    if (instr) instr.addEventListener('click', () => vscode.postMessage({ type: 'emptyCta', action: 'instructions' }));
  }

  function renderMessages(messages) {
    if (!messages.length) {
      messagesEl.innerHTML = emptyHtml();
      bindEmptyCtas();
      return;
    }
    const roleLabel = mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Plan' : mode === 'auto' ? 'Auto' : 'Agent';
    const tools = timeline.filter(t => t.kind === 'tool');
    const other = timeline.filter(t => t.kind !== 'tool');
    const toolHtml = tools.length
      ? '<div class="tool-stream">' + tools.slice(-16).map(t => {
          const st = t.toolStatus || (t.success === false ? 'failed' : t.success ? 'ok' : 'running');
          const detail = t.detail
            ? '<div class="body">' + escapeHtml(t.detail) + '</div>'
            : '';
          const open =
            st === 'running' || (!collapseToolCards && st !== 'running');
          return '<details class="tool-card ' + escapeHtml(st) + '"' +
            (open ? ' open' : '') + '>' +
            '<summary><span class="badge">' + escapeHtml(st) + '</span>' +
            '<span>' + escapeHtml(t.label) + '</span></summary>' + detail + '</details>';
        }).join('') + '</div>'
      : '';
    const activityHtml = other.length
      ? (() => {
          const items = other.slice(-16).map(t => {
            const detail = t.detail
              ? '<div class="tl-detail">' + escapeHtml(t.detail) + '</div>'
              : '';
            return '<div class="tl-item ' + escapeHtml(t.kind) + '"><div class="tl-label">' +
              escapeHtml(t.label) + '</div>' + detail + '</div>';
          }).join('');
          return '<details class="timeline"><summary>Activity · ' + other.length +
            '</summary>' + items + '</details>';
        })()
      : '';

    let html = '';
    messages.forEach((m, idx) => {
      const isLastPending = m.status === 'pending' && idx === messages.length - 1;
      // Tool cards sit in the stream before the pending assistant prose (Cursor-like).
      if (isLastPending && toolHtml) {
        html += toolHtml;
      }
      const inner = m.role === 'assistant'
        ? renderAssistantBody(m.content)
        : '<div class="msg-body">' + escapeHtml(m.content) + '</div>';
      const body = m.role === 'user'
        ? '<div class="bubble">' + inner + '</div>'
        : inner;
      html += '<div class="msg ' + m.role + ' ' + (m.status || '') + '">' +
        '<div class="role">' + (m.role === 'user' ? 'You' : roleLabel) + '</div>' +
        body +
      '</div>';
    });
    // After turn completes, keep tool cards under the last assistant reply.
    const hasPending = messages.some(m => m.status === 'pending');
    if (!hasPending && toolHtml) {
      html += toolHtml;
    }
    if (activityHtml) {
      html += activityHtml;
    }

    messagesEl.innerHTML = html;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Unwrap local-model JSON envelopes and split Actions/Checkpoints footers. */
  function normalizeAssistantContent(raw) {
    const NL = String.fromCharCode(10);
    let text = String(raw || '');
    let meta = '';
    const footer = text.match(new RegExp(NL + NL + '---' + NL + '([\\s\\S]*)$'));
    if (footer) {
      meta = footer[1].trim();
      text = text.slice(0, footer.index).trim();
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && /"message"|"content"/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.message === 'string') text = parsed.message;
        else if (parsed && typeof parsed.content === 'string') text = parsed.content;
        else if (parsed && typeof parsed.text === 'string') text = parsed.text;
      } catch (e) { /* keep raw */ }
    }
    return { text: text.trim(), meta };
  }

  function renderAssistantBody(raw) {
    const parts = normalizeAssistantContent(raw);
    let html = '<div class="msg-body md">' + renderMarkdown(parts.text) + '</div>';
    if (parts.meta) {
      html += '<details class="msg-meta"><summary>Details</summary><pre>' +
        escapeHtml(parts.meta) + '</pre></details>';
    }
    return html;
  }

  function renderMarkdown(src) {
    const NL = String.fromCharCode(10);
    const ph0 = String.fromCharCode(0xE000);
    const ph1 = String.fromCharCode(0xE001);
    const text = String(src || '');
    if (!text) return '';
    const fenceOpen = String.fromCharCode(96, 96, 96);
    const fences = [];
    const fenceRe = new RegExp(fenceOpen + '([\\w+-]*)' + NL + '?([\\s\\S]*?)' + fenceOpen, 'g');
    let s = text.replace(fenceRe, function (_m, lang, code) {
      const i = fences.length;
      fences.push(
        '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
        escapeHtml(String(code).replace(new RegExp(NL + '$'), '')) + '</code></pre>'
      );
      return ph0 + 'FENCE' + i + ph1;
    });
    s = escapeHtml(s);
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    s = s.replace(/^([-*_]{3,})$/gm, '<hr/>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    const tick = String.fromCharCode(96);
    s = s.replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '<code>$1</code>');
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" title="$2">$1</a>');
    s = s.replace(new RegExp('^(?:[-*] .+' + NL + '?)+', 'gm'), function (block) {
      const items = block.trim().split(NL).map(function (line) {
        return '<li>' + line.replace(new RegExp('^[-*]\\\\s+'), '') + '</li>';
      }).join('');
      return '<ul>' + items + '</ul>';
    });
    s = s.replace(new RegExp('^(?:\\\\d+\\\\. .+' + NL + '?)+', 'gm'), function (block) {
      const items = block.trim().split(NL).map(function (line) {
        return '<li>' + line.replace(new RegExp('^\\\\d+\\\\.\\\\s+'), '') + '</li>';
      }).join('');
      return '<ol>' + items + '</ol>';
    });
    s = s.split(new RegExp(NL + '{2,}')).map(function (block) {
      const t = block.trim();
      if (t.indexOf(ph0 + 'FENCE') === 0) return t;
      if (/^<(h[1-4]|ul|ol|pre|blockquote|hr)/.test(t)) return block;
      return '<p>' + block.split(NL).join('<br/>') + '</p>';
    }).join(NL);
    s = s.replace(new RegExp(ph0 + 'FENCE(\\\\d+)' + ph1, 'g'), function (_m, i) {
      return fences[Number(i)] || '';
    });
    return s;
  }

  messagesEl.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href && /^https?:\\/\\//i.test(href)) {
      vscode.postMessage({ type: 'openExternal', url: href });
    }
  });

  var clearBtn = document.getElementById('clearQueueBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'clearQueue' });
    });
  }

  bindEmptyCtas();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}

interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	status?: string;
	timestamp: Date;
}

/** Strip operational footers / checkpoint dumps before sending chat history to the LLM. */
function truncateForLlmHistory(content: string): string {
	let text = content || '';
	// Drop trailing --- Actions/Checkpoints blocks (legacy replies)
	text = text.replace(/\n\n---\n[\s\S]*$/m, '').trim();
	// Drop leading bullet action logs if the whole message is just that
	if (/^Actions:\n/m.test(text) && text.length > 800 && !/\n\n/.test(text.slice(0, 200))) {
		text = text.split(/\n\n/)[0] ?? text;
	}
	// Checkpoint status blocks shown mid-run should not dominate
	if (/^### Checkpoint @ step/m.test(text) && text.length > 1200) {
		const first = text.split(/\n\n/)[0] ?? text;
		text = first.slice(0, 600);
	}
	if (text.length > 4000) {
		text = text.slice(0, 4000) + '…';
	}
	return text;
}

function looksLikeContinue(text: string): boolean {
	return /^(poderia\s+)?(continuar|continua|prosseguir|seguir|continue)(\s+por\s+favor)?\??\.?$/i.test(
		text.trim()
	);
}

function normalizeMode(mode: unknown): AgentMode {
	if (mode === 'ask' || mode === 'plan' || mode === 'auto') return mode;
	return 'agent';
}

function normalizePermissions(level: unknown): Permissions {
	if (level === 'assisted' || level === 'allowAll') return level;
	return 'default';
}
