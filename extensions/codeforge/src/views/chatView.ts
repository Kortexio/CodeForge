/**
 * CodeForge AI - Chat View (Cursor-like right sidebar)
 *
 * Layout target: Explorer left · Editor center · AI Agent right
 */

import * as vscode from 'vscode';
import { VSCodeAIBridge } from '../bridge/vscodeBridge';
import { AiSettingsStore } from '../settings/aiSettingsStore';
import { runAgentWithTools, AgentActivityEvent, type AgentLoopOptions } from '../agent/agentLoop';
import { runOrchestrated } from '../agent/orchestratorRun';
import { runReviewPipeline } from '../agent/reviewPipeline';
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
	getSlashCommand,
} from './slashCommands';
import {
	agentsMdExists,
	generateAgentsMd,
	loadAgentsMdForPrompt,
} from '../agent/projectInstructions';
import { isWeakModel, resolveWeakModelMode } from '../agent/weakModelProfile';
import {
	getEditJournal,
	OriginalContentProvider,
	absFromRel,
	type JournalSummary,
} from '../agent/editJournal';

import { getChatViewHtml } from './chatViewHtml';

type AgentMode = 'ask' | 'plan' | 'agent';
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
	/** User-turn index (0-based). */
	turn?: number;
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
	private _contextUsage: { used: number; limit: number } | null = null;
	private _editSummary: JournalSummary | null = null;
	private _weakHarness = false;
	private _pendingAttachments: PendingAttachment[] = [];
	private _pendingImages: Array<{ mime: string; dataUrl: string; label?: string }> = [];
	private _hasAgentsMd = false;
	private _running = false;
	private _queue: Array<{ id: string; text: string; mode?: AgentMode }> = [];
	/** Set by /cards, /plan-run and /review for the next run only. */
	private _runKind?: 'cards' | 'plan-run' | 'review';
	private _currentTurn = 0;

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
		const rawMode = cfg.get<string>('mode');
		// Migrate legacy "auto" mode → agent + allowAll permissions.
		if (rawMode === 'auto') {
			this._mode = 'agent';
			this._permissions = 'allowAll';
			void cfg.update('mode', 'agent', vscode.ConfigurationTarget.Global);
			try {
				void getApprovalPolicy().allowAutoSession();
			} catch {
				/* ignore */
			}
		} else {
			this._mode = normalizeMode(rawMode);
			try {
				this._permissions = getApprovalPolicy().getPermissionLevel(this._mode);
			} catch {
				this._permissions = cfg.get<boolean>('previewEdits') ? 'assisted' : 'default';
			}
		}
		void ensureWorkspaceIndex().then(() => {
			this._contextBadge = { indexed: getIndexedCount(), inContext: this._contextBadge.inContext };
			this.pushConfig();
		});
		void agentsMdExists().then(v => {
			this._hasAgentsMd = v;
			this.pushConfig();
		});
		getEditJournal().onDidChange(() => {
			void this.refreshEditSummary();
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
		const userTurns = session.messages.filter(m => m.role === 'user').length;
		const lastTurn = Math.max(0, userTurns - 1);
		this._timeline = (session.toolTraces || []).slice(-80).map(t => {
			const args = (t.arguments || {}) as Record<string, unknown>;
			const primary = String(
				args.path ?? args.command ?? args.pattern ?? args.query ?? ''
			)
				.replace(/\s+/g, ' ')
				.trim();
			const title = t.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			const label =
				t.name === 'shell' || t.name === 'dotnet'
					? `Shell ${primary.slice(0, 72) || ''}`.trim()
					: primary
						? `${title} ${primary.slice(0, 72)}`
						: title;
			return {
				id: t.id,
				kind: 'tool' as const,
				label,
				detail: String(t.output || '')
					.replace(/\n*\(lesson —[\s\S]*$/i, '')
					.split(/\r?\n/)
					.filter(
						line =>
							line.trim() &&
							!/^cwd:\s/i.test(line) &&
							!/^sandbox:\s/i.test(line) &&
							!/^exit\s+\d+\s*$/i.test(line.trim())
					)
					.slice(0, 6)
					.join('\n')
					.slice(0, 400),
				tool: t.name,
				toolCallId: t.id,
				toolStatus: (t.success ? 'ok' : 'failed') as 'ok' | 'failed',
				success: t.success,
				turn: t.turn ?? lastTurn,
				ts: Date.parse(t.timestamp) || Date.now(),
			};
		});
		this._messages = session.messages.map(m => ({
			role: m.role,
			content: m.content,
			timestamp: new Date(m.timestamp),
		}));
		this._currentTurn = lastTurn;
		this._queue = [];
		this.pushQueue();
		await this.focus();
		this.updateView();
		if (this._view) {
			this._view.title = session.title.slice(0, 40);
		}
		void this.refreshEditSummary();
	}

	/** QuickPick of past sessions (history icon in view title). */
	async pickSessionHistory(): Promise<void> {
		const sessions = this._sessions.list({ workspaceOnly: true });
		if (!sessions.length) {
			vscode.window.showInformationMessage('No chat sessions yet.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			sessions.map(s => ({
				label: s.title || 'Untitled',
				description: new Date(s.updatedAt).toLocaleString(),
				detail: s.state,
				id: s.id,
			})),
			{ placeHolder: 'Open chat session' }
		);
		if (picked?.id) {
			await this.loadSession(picked.id);
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
				case 'undoAll':
					await this.undoAllEdits();
					break;
				case 'reviewChanges':
					await this.reviewPendingEdits();
					break;
				case 'restoreCheckpoint':
					await this.restoreCheckpoint(Number(message.messageIndex ?? -1));
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
		this._currentTurn = 0;
		this._contextUsage = null;
		this._editSummary = null;
		this._pendingAttachments = [];
		void this._sessions.setActiveId(null);
		getEditJournal().clearSession();
		try {
			getApprovalPolicy().clearSession();
			if (this._permissions === 'allowAll') {
				void getApprovalPolicy().allowAutoSession();
			}
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

	/** Used by CodeForgeApi.chat.openWithPrompt. */
	addPendingAttachments(attachments: PendingAttachment[]): void {
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, attachments);
		this.updateView();
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
		this.pushConfig();
		this.pushQueue();
		// Keep prior-turn timeline; new tools tag with the upcoming turn index.

		await this.maybeResumeForContinue(task);

		// Implicitly accept prior pending edits when starting a new turn.
		getEditJournal().accept();
		void this.refreshEditSummary();

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

		if (this._permissions === 'allowAll' || vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('fullAgentFreedom') === true) {
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

		this._currentTurn = this._messages.filter(m => m.role === 'user').length - 1;
		if (this._currentSessionId) {
			getEditJournal().setContext(this._currentSessionId, this._currentTurn);
		}

		this.addMessage(
			'assistant',
			this._mode === 'ask' ? 'Thinking...' : 'Working...',
			'pending'
		);
		this.updateView();
		this.pushQueue();

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
			void this.refreshEditSummary();
			this.pushConfig();
			this.pushQueue();
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
		await this.handleUserMessage(next.text, next.mode);
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
		// Keep Allow all if the session already granted it; otherwise refresh from policy.
		try {
			const fromPolicy = getApprovalPolicy().getPermissionLevel();
			if (fromPolicy === 'allowAll' || this._permissions === 'allowAll') {
				this._permissions = 'allowAll';
			} else if (fromPolicy === 'assisted') {
				this._permissions = 'assisted';
			} else if (this._permissions !== 'assisted') {
				this._permissions = 'default';
			}
		} catch {
			/* keep current permissions */
		}
		this.pushConfig();
	}

	private async setPermissions(level: Permissions) {
		try {
			await getApprovalPolicy().applyPermissionLevel(level);
			this._permissions = level;
			if (level === 'allowAll' && this._mode === 'ask') {
				await this.setMode('agent');
			} else {
				this.pushConfig();
			}
		} catch (err) {
			vscode.window.showWarningMessage(
				`Could not set permissions: ${err instanceof Error ? err.message : String(err)}`
			);
			this.pushConfig();
		}
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

	private detectWeakHarness(
		_server?: { baseUrl?: string; numCtx?: number } | null,
		_model?: string | null
	): boolean {
		const mode = resolveWeakModelMode(
			vscode.workspace.getConfiguration('codeforge.ai').get<string>('weakModelMode')
		);
		return isWeakModel({}, mode);
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
			contextUsage: this._contextUsage,
			editSummary: this._editSummary,
			running: this._running,
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
				existing.turn = this._currentTurn;
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
			turn: this._currentTurn,
			ts: Date.now(),
		};
		this._timeline.push(item);
		if (this._timeline.length > 120) {
			this._timeline = this._timeline.slice(-120);
		}
		this.updateView();
	}

	private async refreshEditSummary(): Promise<void> {
		try {
			const summary = await getEditJournal().summary(p => this._bridge.readRaw(p));
			this._editSummary = summary.files > 0 ? summary : null;
		} catch {
			this._editSummary = null;
		}
		this.pushConfig();
	}

	private async undoAllEdits(): Promise<void> {
		if (this._running) {
			vscode.window.showWarningMessage('Stop the agent before undoing edits.');
			return;
		}
		const n = await getEditJournal().undoAllPending({
			write: (p, c) => this._bridge.writeRaw(p, c),
			delete: p => this._bridge.deleteRaw(p),
			readRaw: p => this._bridge.readRaw(p),
		});
		await this.refreshEditSummary();
		vscode.window.showInformationMessage(
			n > 0 ? `Reverted ${n} file(s).` : 'No pending edits to undo.'
		);
	}

	private async reviewPendingEdits(): Promise<void> {
		const pending = getEditJournal().listPending();
		if (!pending.length) {
			vscode.window.showInformationMessage('No pending edits to review.');
			return;
		}
		const byPath = new Map<string, (typeof pending)[0]>();
		for (const e of pending) {
			if (!byPath.has(e.path)) byPath.set(e.path, e);
		}
		for (const e of byPath.values()) {
			const abs = absFromRel(e.path);
			const left = OriginalContentProvider.uriFor(e.path);
			const right = vscode.Uri.file(abs);
			await vscode.commands.executeCommand(
				'vscode.diff',
				left,
				right,
				`${e.path} (original ↔ current)`
			);
		}
	}

	private async restoreCheckpoint(messageIndex: number): Promise<void> {
		if (this._running) {
			vscode.window.showWarningMessage('Stop the agent before restoring a checkpoint.');
			return;
		}
		if (!Number.isFinite(messageIndex) || messageIndex < 0 || messageIndex >= this._messages.length) {
			vscode.window.showWarningMessage('Could not find that message to restore.');
			return;
		}
		const msg = this._messages[messageIndex];
		if (msg.role !== 'user') {
			vscode.window.showWarningMessage('Restore checkpoint only works on your messages.');
			return;
		}

		const confirm = await vscode.window.showWarningMessage(
			'Restore checkpoint? File edits from this turn onward will be reverted and later chat messages removed. Your prompt will return to the input box.',
			{ modal: true },
			'Restore'
		);
		if (confirm !== 'Restore') return;

		const userTurn =
			this._messages.slice(0, messageIndex + 1).filter(m => m.role === 'user').length - 1;
		// Prefer the short user-visible prompt (strip attachment blocks).
		const promptText = msg.content.split(/\n\n(?:Attached |Images:|---)/)[0]?.trim() || msg.content;

		try {
			await getEditJournal().revertTurns(Math.max(0, userTurn), {
				write: (p, c) => this._bridge.writeRaw(p, c),
				delete: p => this._bridge.deleteRaw(p),
				readRaw: p => this._bridge.readRaw(p),
			});
		} catch (err) {
			vscode.window.showErrorMessage(
				`Could not revert files: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		if (this._currentSessionId) {
			await this._sessions.truncateFrom(this._currentSessionId, messageIndex);
		}

		this._messages = this._messages.slice(0, messageIndex);
		this._timeline = this._timeline.filter(
			t => t.turn !== undefined && t.turn !== null && t.turn < userTurn
		);
		this._currentTurn = Math.max(0, userTurn - 1);
		this._cancelled = false;
		await this.refreshEditSummary();
		this.updateView();
		this.pushConfig();
		this._view?.webview.postMessage({ type: 'restorePrompt', text: promptText });
		vscode.window.showInformationMessage('Checkpoint restored — prompt is back in the input box.');
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
				onContextUsage: usage => {
					this._contextUsage = usage;
					this.pushConfig();
				},
				onTaskUpdate: this._onTaskUpdate,
				sessionStore: this._sessions,
				sessionId: this._currentSessionId,
				turnIndex: this._currentTurn,
				maxSteps: cfgAgentPlan.get<number>('agentCheckpointSteps') ?? 30,
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
		const runKind = this._runKind;
		this._runKind = undefined;
		const agentOpts: AgentLoopOptions = {
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
			onContextUsage: usage => {
				this._contextUsage = usage;
				this.pushConfig();
			},
			onTaskUpdate: this._onTaskUpdate,
			sessionStore: this._sessions,
			sessionId: this._currentSessionId,
			turnIndex: this._currentTurn,
			maxSteps: cfgAgent.get<number>('agentCheckpointSteps') ?? 30,
			hardCap: cfgAgent.get<number>('agentHardCap') ?? 100,
			weakProfile,
		};
		if (runKind === 'review') {
			const reviewed = await runReviewPipeline(agentOpts, { forced: true });
			if (reviewed) return reviewed;
		}
		if (runKind !== 'review') {
			const orchestrated = await runOrchestrated(agentOpts, { forced: !!runKind });
			if (orchestrated) return orchestrated;
		}
		return runAgentWithTools(agentOpts);
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
			usage?: { prompt_tokens?: number; input_tokens?: number };
		};
		const used = Number(data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0) || 0;
		const { server: askServer } = this._store.getActiveSelection();
		const limit = askServer?.numCtx && askServer.numCtx > 0 ? askServer.numCtx : 0;
		if (used > 0 && limit > 0) {
			this._contextUsage = { used, limit };
			this.pushConfig();
		}
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

	private async dispatchSlash(command: string, args: string): Promise<boolean> {
		switch (command) {
			case 'cards':
			case 'plan-run':
			case 'review': {
				if (this._running) {
					this.enqueueMessage(`/${command}${args ? ` ${args}` : ''}`);
					return true;
				}
				const fallback =
					command === 'cards'
						? 'Implement the cards in docs/ in dependency order.'
						: command === 'review'
							? 'Review the code in this workspace and find bugs.'
							: '';
				const task = args || fallback;
				if (!task) {
					this.addMessage('user', '/plan-run');
					this.addMessage('assistant', 'Usage: /plan-run <what to build>');
					return true;
				}
				this._runKind = command;
				await this.runTask(task, this._mode === 'ask' || this._mode === 'plan' ? 'agent' : undefined);
				return true;
			}
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
				await this.setMode('agent');
				await this.setPermissions('allowAll');
				this.addMessage('user', '/auto');
				this.addMessage('assistant', 'Allow all enabled for this session (Agent mode).');
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
			default: {
				const ext = getSlashCommand(command);
				if (ext?.run) {
					this.addMessage('user', `/${command}${args ? ` ${args}` : ''}`);
					await ext.run(args);
					return true;
				}
				this.addMessage('user', `/${command}`);
				this.addMessage(
					'assistant',
					`Unknown command /${command}. Try /help for the list.`
				);
				return true;
			}
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
		return getChatViewHtml();
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
	if (mode === 'ask' || mode === 'plan') return mode;
	// Legacy "auto" → agent (permissions handled separately).
	return 'agent';
}

function normalizePermissions(level: unknown): Permissions {
	if (level === 'assisted' || level === 'allowAll') return level;
	return 'default';
}
