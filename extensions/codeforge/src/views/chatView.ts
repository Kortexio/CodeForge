/**
 * CodeForge AI - Chat View (Cursor-like right sidebar)
 *
 * Layout target: Explorer left · Editor center · AI Agent right
 */

import * as vscode from 'vscode';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { VSCodeAIBridge } from '../bridge/vscodeBridge';
import { AiSettingsStore } from '../settings/aiSettingsStore';
import { runAgentWithTools, AgentActivityEvent, type AgentLoopOptions } from '../agent/agentLoop';
import { SteeringQueue } from '../agent/steeringQueue';
import {
	cachedLlamaSlots,
	effectiveContextBudget,
	llamaSlotsProbed,
	refreshLlamaSlots,
	slotCap,
} from '../agent/llamaSlots';
import { SessionFlightRegistry, type FlightHandle } from '../agent/sessionFlights';
import { runWithJournalContext } from '../agent/journalContext';
import { runOrchestrated } from '../agent/orchestratorRun';
import { runReviewPipeline } from '../agent/reviewPipeline';
import { anyVisionModelAvailable, resolveReachableVisionRoute } from '../agent/visionRouting';
import { SessionStore, type MessageTimings } from '../sessions/sessionStore';
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
	createProtocolAggregator,
	flushRunTelemetry,
	type ProtocolAggregator,
} from '../agent/protocolTelemetry';
import {
	getEditJournal,
	OriginalContentProvider,
	absFromRel,
	type JournalSummary,
} from '../agent/editJournal';

import { randomBytes } from 'crypto';
import { getChatViewHtml } from './chatViewHtml';
import type { ExternalChatHandle, ExternalChatSession } from '../api';
import {
	CONTINUE_TURN_PROMPT,
	type AgentsTurnResult,
	type LoopExit,
	type TurnObserver,
	type TurnOutcome,
} from './turnContract';
import { TurnWaiterRegistry, appendAssistantThought } from './turnWaiters';

const OPEN_TABS_KEY = 'codeforge.ai.openSessionIds';

type AgentMode = 'ask' | 'plan' | 'agent';
type Permissions = PermissionLevel;

export type { ExternalChatHandle, ExternalChatSession };

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

interface SessionUi {
	messages: ChatMessage[];
	timeline: TimelineItem[];
	queue: SteeringQueue;
	currentTurn: number;
	turnReasoning: string;
	turnTimings?: MessageTimings;
	lastLoopExit?: LoopExit;
	contextUsage: { used: number; limit: number } | null;
	protocolAgg?: ProtocolAggregator;
	protocolMeta?: { serverId: string; model: string; startedAt: number };
	/** Mode frozen when the flight started. */
	mode?: AgentMode;
}

interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	status?: string;
	timestamp: Date;
	reasoning?: string;
	timings?: MessageTimings;
	model?: string;
	/** Live wait label shown while status === 'pending' (Cursor-style Thinking…). */
	liveStatus?: string;
	/** Show Continue when the tool loop hit the step budget. */
	continueAvailable?: boolean;
}

interface WebviewMessage {
	type: string;
	text?: unknown;
	mode?: unknown;
	level?: unknown;
	action?: unknown;
	uriList?: unknown;
	blobs?: unknown;
	url?: unknown;
	id?: unknown;
	messageIndex?: unknown;
	code?: unknown;
	fromRunButton?: unknown;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _extensionUri: vscode.Uri;
	private _messages: ChatMessage[] = [];
	private _timeline: TimelineItem[] = [];
	private _bridge: VSCodeAIBridge;
	private _store: AiSettingsStore;
	private _sessions: SessionStore;
	private _external?: {
		session: ExternalChatSession;
		messages: Array<{ role: 'user' | 'assistant'; content: string; status?: string }>;
		timeline: Array<{
			id: string;
			kind: 'tool' | 'thought' | 'checkpoint';
			label: string;
			detail?: string;
			tool?: string;
			toolStatus?: 'running' | 'ok' | 'failed';
			turn?: number;
		}>;
		running: boolean;
	};
	private _currentSessionId: string | null = null;
	private _flights = new SessionFlightRegistry(() => this.slotCapNow());
	private _sessionUi = new Map<string, SessionUi>();
	private _mode: AgentMode = 'agent';
	private _permissions: Permissions = 'default';
	private _contextBadge = { indexed: 0, inContext: 0 };
	private _contextUsage: { used: number; limit: number } | null = null;
	private _editSummary: JournalSummary | null = null;
	private _weakHarness = false;
	private _pendingAttachments: PendingAttachment[] = [];
	private _pendingImages: Array<{ mime: string; dataUrl: string; label?: string }> = [];
	private _hasAgentsMd = false;
	/** Last tool-loop exit reason from runAgentWithTools (for Continue button). */
	private _lastLoopExit: LoopExit | undefined;
	private _turnWaiters = new TurnWaiterRegistry();
	private _queue = new SteeringQueue();
	private _orphanQueue = new SteeringQueue();
	/** Set by /cards, /plan-run and /review for the next run only. */
	private _runKind?: 'cards' | 'plan-run' | 'review';
	private _currentTurn = 0;
	/** Protocol telemetry for the in-flight turn (flushed when the turn ends). */
	private _protocolAgg: ProtocolAggregator | undefined;
	private _protocolMeta:
		| { serverId: string; model: string; startedAt: number }
		| undefined;
	private _openSessionIds: string[] = [];
	private _turnReasoning = '';
	private _turnTimings: MessageTimings | undefined;
	private _pythonProc: ChildProcessWithoutNullStreams | undefined;
	private _context?: vscode.ExtensionContext;

	/** Shows an external session in the chat (e.g. ticket mirror from a Studio vertical). */
	attachExternal(session: ExternalChatSession): ExternalChatHandle {
		const previous = this._external;
		const state: NonNullable<typeof this._external> = {
			session,
			messages: [],
			timeline: [],
			running: false,
		};
		this._external = state;
		if (previous && previous.session !== session) previous.session.onDetach?.();
		void vscode.commands.executeCommand('codeforge.focusChat');
		if (this._view) this._view.title = session.title || 'Agent';
		const isCurrent = () => this._external === state;
		return {
			id: session.id,
			get attached() {
				return isCurrent();
			},
			setMessages: (messages, timeline) => {
				state.messages = messages;
				state.timeline = timeline;
			},
			setRunning: running => {
				state.running = running;
			},
			update: patch => {
				Object.assign(state.session, patch);
				if (isCurrent() && this._view && patch.title) this._view.title = patch.title;
			},
			dispose: () => {
				if (isCurrent()) {
					this._external = undefined;
					if (this._view) this._view.title = 'Agent';
					previous?.session.onDetach?.();
				}
			},
		};
	}

	constructor(
		extensionUri: vscode.Uri,
		bridge: VSCodeAIBridge,
		_output: vscode.OutputChannel,
		store: AiSettingsStore,
		sessions: SessionStore,
		context?: vscode.ExtensionContext
	) {
		this._extensionUri = extensionUri;
		this._bridge = bridge;
		this._store = store;
		this._sessions = sessions;
		this._context = context;
		this._openSessionIds = this.readOpenTabs();
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
			if (e.affectsConfiguration('codeforge.ai.mode')) {
				const next = normalizeMode(vscode.workspace.getConfiguration('codeforge.ai').get<string>('mode'));
				if (next !== this._mode) {
					this._mode = next;
					this.pushConfig();
				}
			}
			if (
				e.affectsConfiguration('codeforge.ai.collapseToolCards') ||
				e.affectsConfiguration('codeforge.ai.enabled') ||
				e.affectsConfiguration('codeforge.ai.allowAll')
			) {
				if (e.affectsConfiguration('codeforge.ai.allowAll')) {
					try {
						this._permissions = getApprovalPolicy().getPermissionLevel(this._mode);
					} catch {
						/* ignore */
					}
					this.pushConfig();
				}
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

	private slotCapNow(): number {
		const { server, model } = this._store.getActiveSelection();
		return slotCap(server?.id, model);
	}

	private visibleBusy(): boolean {
		return !!this._currentSessionId && this._flights.has(this._currentSessionId);
	}

	private runningIds(): string[] {
		return this._flights.ids();
	}

	private uiFor(sessionId: string): SessionUi {
		let ui = this._sessionUi.get(sessionId);
		if (!ui) {
			ui = {
				messages: [],
				timeline: [],
				queue: new SteeringQueue(),
				currentTurn: 0,
				turnReasoning: '',
				contextUsage: null,
			};
			this._sessionUi.set(sessionId, ui);
		}
		return ui;
	}

	private queueFor(sessionId: string | null): SteeringQueue {
		if (!sessionId) return this._orphanQueue;
		return this.uiFor(sessionId).queue;
	}

	private bindVisible(sessionId: string | null): void {
		if (!sessionId) {
			this._messages = [];
			this._timeline = [];
			this._queue = this._orphanQueue;
			this._currentTurn = 0;
			this._turnReasoning = '';
			this._turnTimings = undefined;
			this._lastLoopExit = undefined;
			this._contextUsage = null;
			return;
		}
		const ui = this.uiFor(sessionId);
		this._messages = ui.messages;
		this._timeline = ui.timeline;
		this._queue = ui.queue;
		this._currentTurn = ui.currentTurn;
		this._turnReasoning = ui.turnReasoning;
		this._turnTimings = ui.turnTimings;
		this._lastLoopExit = ui.lastLoopExit;
		this._contextUsage = ui.contextUsage;
	}

	private persistVisible(): void {
		const id = this._currentSessionId;
		if (!id) return;
		const ui = this.uiFor(id);
		ui.messages = this._messages;
		ui.timeline = this._timeline;
		ui.queue = this._queue;
		ui.currentTurn = this._currentTurn;
		ui.turnReasoning = this._turnReasoning;
		ui.turnTimings = this._turnTimings;
		ui.lastLoopExit = this._lastLoopExit;
		ui.contextUsage = this._contextUsage;
	}

	async loadSession(sessionId: string, options: { reveal?: boolean } = {}): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			void vscode.window.showWarningMessage('Session not found');
			return;
		}
		this.persistVisible();
		this.stopPython();
		this._currentSessionId = session.id;
		await this._sessions.setActiveId(session.id);
		this.ensureOpenTab(session.id);
		if (!this._flights.size()) {
			try {
				getApprovalPolicy().clearSession();
			} catch {
				/* ignore */
			}
		}
		if (this._flights.has(sessionId)) {
			this.bindVisible(sessionId);
			getEditJournal().setContext(sessionId, this.uiFor(sessionId).currentTurn);
			if (options.reveal !== false) {
				await this.focus();
			}
			this.updateView();
			this.pushTabs();
			this.pushQueue();
			this.pushConfig();
			if (this._view) {
				this._view.title = session.title.slice(0, 40);
			}
			void this.refreshEditSummary();
			return;
		}
		const userTurns = session.messages.filter(m => m.role === 'user').length;
		const lastTurn = Math.max(0, userTurns - 1);
		this._timeline = (session.toolTraces || []).slice(-80).map(t => {
			const args = (t.arguments || {});
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
				toolStatus: (t.success ? 'ok' : 'failed'),
				success: t.success,
				turn: t.turn ?? lastTurn,
				ts: Date.parse(t.timestamp) || Date.now(),
			};
		});
		this._messages = session.messages.map(m => ({
			role: m.role,
			content: m.content,
			timestamp: new Date(m.timestamp),
			reasoning: m.reasoning,
			timings: m.timings,
			model: session.model,
		}));
		this._currentTurn = lastTurn;
		this._queue.clear();
		this.persistVisible();
		this.bindVisible(session.id);
		getEditJournal().setContext(session.id, lastTurn);
		this.pushQueue();
		if (options.reveal !== false) {
			await this.focus();
		}
		this.updateView();
		this.pushTabs();
		if (this._view) {
			this._view.title = session.title.slice(0, 40);
		}
		void this.refreshEditSummary();
	}

	/** QuickPick of past sessions (history icon in view title). */
	async pickSessionHistory(): Promise<void> {
		const sessions = this._sessions.list({ workspaceOnly: true });
		if (!sessions.length) {
			void vscode.window.showInformationMessage('No chat sessions yet.');
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
			localResourceRoots: [
				this._extensionUri,
				vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview'),
			],
		};

		webviewView.webview.html = this._getHtmlContent();

		webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
			switch (message.type) {
				case 'ready':
					this.pushConfig();
					this.pushQueue();
					this.pushTabs();
					await this.restoreActiveSessionIfNeeded();
					this.updateView();
					this.pushTabs();
					break;
				case 'sendMessage':
					await this.handleUserMessage(
						String(message.text ?? ''),
						message.mode as AgentMode | undefined
					);
					break;
				case 'continueTurn':
					await this.handleContinueTurn();
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
						void this._view?.webview.postMessage({ type: 'focusInput' });
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
					this._queue.clear();
					this.pushQueue();
					break;
				case 'steer':
					await this.enqueueSteering(String(message.text ?? ''), message.mode as AgentMode | undefined);
					break;
				case 'followUp':
					this.enqueueMessage(String(message.text ?? ''), message.mode as AgentMode | undefined);
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
				case 'switchTab':
					await this.switchTab(String(message.id ?? ''));
					break;
				case 'closeTab':
					await this.closeTab(String(message.id ?? ''));
					break;
				case 'branchAt':
					await this.branchAt(Number(message.messageIndex ?? -1));
					break;
				case 'regenerate':
					await this.regenerateAt(Number(message.messageIndex ?? -1));
					break;
				case 'runPython':
					if (message.fromRunButton !== true) {
						break;
					}
					await this.runPython(String(message.code ?? ''));
					break;
				case 'stopPython':
					this.stopPython();
					break;
			}
		});
	}

	newChat() {
		this.persistVisible();
		this.stopPython();
		this._currentSessionId = null;
		this.bindVisible(null);
		this._editSummary = null;
		this._pendingAttachments = [];
		void this._sessions.setActiveId(null);
		if (!this._flights.size()) {
			getEditJournal().clearSession();
			try {
				getApprovalPolicy().clearSession();
				if (this._permissions === 'allowAll') {
					void getApprovalPolicy().allowAutoSession();
				}
			} catch {
				/* policy may not be ready */
			}
		}
		if (this._view) {
			this._view.title = 'Agent';
		}
		this.updateView();
		this.pushQueue();
		this.pushConfig();
		this.pushTabs();
	}

	private async restoreActiveSessionIfNeeded(): Promise<void> {
		if (this._messages.length || this._currentSessionId) return;
		const activeId = this._sessions.getActiveId();
		const session = (activeId && this._sessions.get(activeId)) || this._sessions.latest();
		if (session?.messages.length) {
			await this.loadSession(session.id);
		}
	}

	private async maybeResumeForContinue(task: string): Promise<void> {
		if (this._messages.length > 0 || this._currentSessionId) return;
		if (!looksLikeContinue(task)) return;
		const latest = this._sessions.latest();
		if (!latest?.messages.length) return;
		await this.loadSession(latest.id);
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

	/**
	 * Runs one turn for the Agents window through the same pipeline as the side chat
	 * (sessions, harness, approvals, telemetry). Resolves when the turn's outcome is
	 * known; queued side-chat follow-ups keep running afterwards without blocking it.
	 */
	async runAgentsTurn(
		task: string,
		sessionId: string | undefined,
		observer: TurnObserver,
		token: vscode.CancellationToken
	): Promise<AgentsTurnResult> {
		const target = sessionId && this._sessions.get(sessionId) ? sessionId : undefined;
		if (target && this._flights.has(target)) {
			return { kind: 'busy' };
		}
		if (!this._flights.canStart(target ?? `__agents-probe-${Date.now()}`)) {
			return { kind: 'busy' };
		}
		if (sessionId && this._sessions.get(sessionId)) {
			if (this._currentSessionId !== sessionId) {
				await this.loadSession(sessionId, { reveal: false });
			}
		} else if (this._currentSessionId && this._flights.has(this._currentSessionId)) {
			this.newChat();
		}

		const { server, model } = this._store.getActiveSelection();
		let sid = this._currentSessionId;
		if (!sid) {
			const session = await this._sessions.create({
				task,
				model,
				serverName: server?.name,
			});
			sid = session.id;
			this._currentSessionId = sid;
			this.bindVisible(sid);
			this.ensureOpenTab(sid);
			await this._sessions.setActiveId(sid);
			this.pushTabs();
		}
		if (this._flights.has(sid) || !this._flights.canStart(sid)) {
			return { kind: 'busy' };
		}

		const settled = new Promise<TurnOutcome>(resolve => {
			this._turnWaiters.register(sid!, resolve, observer);
		});
		const cancel = token.onCancellationRequested(() => {
			if (this._turnWaiters.has(sid!)) {
				void this.cancelTask(sid!);
			}
		});
		try {
			const handled = this.handleUserMessage(task).then((): TurnOutcome => {
				const msgs = this.uiFor(sid!).messages;
				const last = msgs[msgs.length - 1];
				return {
					sessionId: sid!,
					reply: last?.role === 'assistant' ? last.content : '',
					loopExit: 'done',
				};
			});
			const outcome = await Promise.race([settled, handled]);
			return { kind: 'finished', ...outcome };
		} finally {
			cancel.dispose();
			this._turnWaiters.clear(sid!, observer);
		}
	}

	private settleTurn(outcome: TurnOutcome): void {
		this._turnWaiters.settle(outcome.sessionId, outcome);
	}

	async runTask(task: string, mode?: AgentMode) {
		if (mode) {
			await this.setMode(mode);
		}
		const aiEnabled =
			vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('enabled') !== false;
		if (!aiEnabled) {
			const disabled =
				'AI Agent is disabled. Enable it in Settings → AI → Agent (`codeforge.ai.enabled`), then try again.';
			this.addMessage('user', task);
			this.addMessage('assistant', disabled);
			this.settleTurn({ sessionId: this._currentSessionId, reply: disabled, loopExit: 'error' });
			return;
		}
		await this.maybeResumeForContinue(task);

		const { server, model } = this._store.getActiveSelection();
		if (!this._currentSessionId) {
			const session = await this._sessions.create({
				task,
				model: model,
				serverName: server?.name,
			});
			this._currentSessionId = session.id;
			this.bindVisible(session.id);
			this.ensureOpenTab(session.id);
			if (this._view) {
				this._view.title = session.title.slice(0, 40);
			}
			this.pushTabs();
		} else {
			await this._sessions.setActiveId(this._currentSessionId);
			this.ensureOpenTab(this._currentSessionId);
			this.pushTabs();
		}

		const sid = this._currentSessionId;
		if (!sid) return;
		if (this._flights.has(sid)) {
			this.enqueueMessage(task, mode, sid);
			return;
		}
		const handle = this._flights.start(sid);
		if (!handle) {
			this.enqueueMessage(task, mode, sid);
			return;
		}
		this.uiFor(sid).mode = this._mode;

		this.pushConfig();
		this.pushQueue();
		this.pushTabs();

		getEditJournal().accept(sid);
		void this.refreshEditSummary();

		if (this._permissions === 'allowAll' || vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('fullAgentFreedom') === true) {
			try {
				await getApprovalPolicy().allowAutoSession();
			} catch {
				/* ignore */
			}
		}

		const attached = this._pendingAttachments;
		let displayTask = task;
		let agentTask = task;
		let images: Array<{ mime: string; dataUrl: string; label?: string }> = [];
		if (attached.length) {
			const payload = buildAttachmentPayload(attached);
			if (payload.textBlock) {
				displayTask = `${task}\n\n${payload.textBlock}`;
				agentTask = `${agentTask}\n\n${payload.textBlock}`;
			}
			images = payload.images;
			this._pendingAttachments = [];
			this.pushConfig();
		}
		this._pendingImages = images;

		// Keep full content (incl. attachments) in in-memory history for follow-up turns.
		// Images are referenced by label in stored text (base64 kept only for this turn).
		// Bare "continue" stays short in the chat; agentTask may include a harness stall note.
		const historyText =
			images.length > 0
				? `${displayTask}\n\n(Attached images: ${images.map(i => i.label || 'image').join(', ')})`
				: displayTask;
		this.addMessage('user', historyText, undefined, sid);
		await this._sessions.appendMessage(sid, 'user', historyText);
		await this._sessions.updateState(sid, 'running');

		const ui = this.uiFor(sid);
		ui.currentTurn = ui.messages.filter(m => m.role === 'user').length - 1;
		if (this._currentSessionId === sid) this._currentTurn = ui.currentTurn;
		getEditJournal().setContext(sid, ui.currentTurn);

		this.addMessage('assistant', '', 'pending', sid);
		const pending = ui.messages[ui.messages.length - 1];
		if (pending?.role === 'assistant') {
			pending.liveStatus = ui.mode === 'ask' ? 'Thinking' : 'Planning next moves';
		}
		ui.turnReasoning = '';
		ui.turnTimings = undefined;
		ui.lastLoopExit = undefined;
		ui.protocolAgg = createProtocolAggregator();
		ui.protocolMeta = {
			serverId: server?.id || 'unknown',
			model: model || 'unknown',
			startedAt: Date.now(),
		};
		if (this._currentSessionId === sid) {
			this._turnReasoning = '';
			this._turnTimings = undefined;
			this._lastLoopExit = undefined;
			this._protocolAgg = ui.protocolAgg;
			this._protocolMeta = ui.protocolMeta;
		}
		this.paintSession(sid);
		this.pushQueue();

		let loopExit = 'done' as LoopExit;
		let finalReply = '';
		try {
			const reply = await runWithJournalContext({ sessionId: sid, turn: ui.currentTurn }, () =>
				this.executeLocalAgent(agentTask, images, sid, handle)
			);
			if (!handle.cancelled) {
				loopExit = (this.uiFor(sid).lastLoopExit as LoopExit | undefined) ?? 'done';
				finalReply = reply;
				const extra = {
					reasoning: this.uiFor(sid).turnReasoning || undefined,
					timings: this.uiFor(sid).turnTimings,
					continueAvailable: loopExit === 'budget',
				};
				this.updateLastMessage('assistant', reply, undefined, extra, sid);
				await this._sessions.appendMessage(sid, 'assistant', reply, {
					reasoning: extra.reasoning,
					timings: extra.timings,
				});
				await this._sessions.updateState(sid, loopExit === 'budget' ? 'failed' : 'completed');
			} else {
				loopExit = 'cancelled';
				await this._sessions.updateState(sid, 'cancelled');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (handle.cancelled || /abort/i.test(message)) {
				loopExit = 'cancelled';
				finalReply = 'Cancelled.';
				this.updateLastMessage('assistant', 'Cancelled.', undefined, undefined, sid);
				const session = this._sessions.get(sid);
				const last = session?.messages[session.messages.length - 1];
				if (!(last?.role === 'assistant' && /Cancelled/i.test(last.content))) {
					await this._sessions.appendMessage(sid, 'assistant', 'Cancelled.');
				}
				await this._sessions.updateState(sid, 'cancelled');
			} else {
				loopExit = 'error';
				finalReply = `Error: ${message}`;
				this.updateLastMessage('assistant', `Error: ${message}`, undefined, undefined, sid);
				await this._sessions.appendMessage(sid, 'assistant', `Error: ${message}`);
				await this._sessions.updateState(sid, 'failed');
			}
		} finally {
			const doneUi = this.uiFor(sid);
			try {
				if (doneUi.protocolAgg && doneUi.protocolMeta) {
					flushRunTelemetry({
						serverId: doneUi.protocolMeta.serverId,
						model: doneUi.protocolMeta.model,
						source: 'chat',
						sessionId: sid,
						loopExit,
						elapsedMs: Date.now() - doneUi.protocolMeta.startedAt,
						aggregator: doneUi.protocolAgg,
					});
				}
			} catch {
				/* best-effort */
			}
			doneUi.protocolAgg = undefined;
			doneUi.protocolMeta = undefined;
			this._flights.end(sid);
			this._pendingImages = [];
			void this.refreshEditSummary();
			this.pushConfig();
			this.pushQueue();
			this.paintSession(sid);
			this.settleTurn({ sessionId: sid, reply: finalReply, loopExit });
			await this.drainQueueFor(sid);
			await this.drainWaitingSessions();
		}
	}

	private paintSession(sessionId: string): void {
		if (this._currentSessionId === sessionId) {
			this.bindVisible(sessionId);
			this.updateView();
		}
		this.pushTabs();
	}

	private observeActivity(ev: AgentActivityEvent, sessionId?: string): void {
		const sid = sessionId ?? this._currentSessionId;
		this._turnWaiters.observer(sid)?.onActivity(ev);
		this.pushActivity(ev, sid ?? undefined);
		if (sid) this.uiFor(sid).protocolAgg?.observe(ev);
		else this._protocolAgg?.observe(ev);
	}

	private enqueueMessage(text: string, mode?: AgentMode, sessionId?: string): void {
		const sid = sessionId ?? this._currentSessionId;
		this.queueFor(sid).push('followup', text, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, mode);
		this.pushQueue();
	}

	/** Mid-turn note: visible in the transcript and injected before the next model request. */
	private async enqueueSteering(text: string, mode?: AgentMode): Promise<void> {
		const item = this._queue.push('steer', text, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, mode);
		if (!item) return;
		this.addMessage('user', item.text);
		if (this._currentSessionId) {
			await this._sessions.appendMessage(this._currentSessionId, 'user', item.text);
		}
		this.pushQueue();
	}

	private removeQueued(id: string): void {
		this._queue.remove(id);
		this.pushQueue();
	}

	private pushQueue(): void {
		void this._view?.webview.postMessage({
			type: 'queue',
			items: this._queue.items.map(item => ({ id: item.id, text: item.text, kind: item.kind })),
			running: this.visibleBusy(),
		});
	}

	private takeSteering(sessionId?: string): string[] {
		const notes = this.queueFor(sessionId ?? this._currentSessionId).drainSteering();
		if (notes.length) this.pushQueue();
		return notes;
	}

	private async drainQueueFor(sessionId: string): Promise<void> {
		const next = this.uiFor(sessionId).queue.shiftFollowUp();
		this.pushQueue();
		if (!next) return;
		if (this._currentSessionId !== sessionId) {
			await this.loadSession(sessionId, { reveal: false });
		}
		await this.handleUserMessage(next.text, next.mode as AgentMode | undefined);
	}

	private async drainWaitingSessions(): Promise<void> {
		if (this._flights.size() >= this._flights.cap()) return;
		for (const [id, ui] of this._sessionUi) {
			if (this._flights.has(id)) continue;
			if (!ui.queue.items.some(i => i.kind === 'followup')) continue;
			if (!this._flights.canStart(id)) return;
			await this.drainQueueFor(id);
			if (this._flights.size() >= this._flights.cap()) return;
		}
	}

	async cancelTask(taskId?: string) {
		let sid = this._currentSessionId;
		if (taskId) {
			if (this._flights.abortSub(taskId)) {
				void vscode.window.showInformationMessage('Subagent cancelled');
				return;
			}
			sid = taskId.includes('-sub-') ? taskId.slice(0, taskId.indexOf('-sub-')) : taskId;
		}
		if (!sid || !this._flights.has(sid)) {
			if (!taskId) {
				void vscode.window.showInformationMessage('No running task');
			}
			return;
		}
		this._flights.abort(sid);
		try {
			this._bridge.abortRunningShells();
		} catch {
			/* ignore */
		}
		void vscode.window.showInformationMessage('Task cancelled');
		this.updateLastMessage('assistant', 'Cancelled.', undefined, undefined, sid);
		this.pushActivity(
			{
				kind: 'checkpoint',
				label: 'Stopped',
				detail: 'User cancelled',
			},
			sid
		);
		const session = this._sessions.get(sid);
		const last = session?.messages[session.messages.length - 1];
		if (!(last?.role === 'assistant' && last.content === 'Cancelled.')) {
			await this._sessions.appendMessage(sid, 'assistant', 'Cancelled.');
		}
		await this._sessions.updateState(sid, 'cancelled');
		this.paintSession(sid);
	}

	/** No configured, enabled server has an image-capable model — images must not be attached. */
	private canAttachImages(): boolean {
		return anyVisionModelAvailable(this._store.getState());
	}

	private async pickAttachments(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: 'Attach to Agent',
		});
		if (!uris?.length) return;
		const next = await attachmentsFromUris(uris, this.canAttachImages());
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, next);
		this.pushConfig();
	}

	private async attachFromUriList(uriList: string): Promise<void> {
		const uris = parseDroppedUriList(uriList);
		if (!uris.length) return;
		const next = await attachmentsFromUris(uris, this.canAttachImages());
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, next);
		this.pushConfig();
	}

	private attachFromBlobs(
		blobs: Array<{ name: string; mime?: string; base64: string }>
	): Promise<void> {
		const canImages = this.canAttachImages();
		const next: PendingAttachment[] = [];
		for (const blob of blobs.slice(0, 8)) {
			const att = attachmentFromBlob(blob, canImages);
			if (att) next.push(att);
		}
		if (!next.length) return Promise.resolve();
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, next);
		this.pushConfig();
		return Promise.resolve();
	}

	private attachHttpUrl(url: string): void {
		if (!isHttpUrl(url)) return;
		this._pendingAttachments = mergeAttachments(this._pendingAttachments, [
			attachmentFromHttpUrl(url),
		]);
		this.pushConfig();
	}

	getMode(): AgentMode {
		return this._mode;
	}

	getPermissions(): Permissions {
		return this._permissions;
	}

	async setMode(mode: AgentMode) {
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

	async setPermissions(level: Permissions) {
		try {
			await getApprovalPolicy().applyPermissionLevel(level);
			this._permissions = level;
			if (level === 'allowAll' && this._mode === 'ask') {
				await this.setMode('agent');
			} else {
				this.pushConfig();
			}
		} catch (err) {
			void vscode.window.showWarningMessage(
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
				abortSignal: this._currentSessionId
					? this._flights.get(this._currentSessionId)?.abort.signal
					: undefined,
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

	private async resolveNumCtx(
		serverId: string,
		configured: number | undefined,
		model: string,
		baseUrl: string,
		apiKey: string
	): Promise<number | undefined> {
		if (baseUrl && !llamaSlotsProbed(serverId, model)) {
			await refreshLlamaSlots({
				serverId,
				model,
				baseUrl,
				apiKey,
				configuredCtx: configured,
			});
			this.pushConfig();
		}
		return effectiveContextBudget(configured, cachedLlamaSlots(serverId, model));
	}

	private getModelLabel(): string {
		const { server, model } = this._store.getActiveSelection();
		if (server && model) {
			const slots = cachedLlamaSlots(server.id, model);
			const parallel = slots ? ` · parallel ${slots.parallel}` : '';
			return `${server.name} · ${model}${parallel}`;
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
		void this._view.webview.postMessage({
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
			running: this.visibleBusy(),
			hasAgentsMd: this._hasAgentsMd,
			weakHarness: this._weakHarness,
			slashCommands: SLASH_COMMANDS,
			canAttachImages: this.canAttachImages(),
			attachments: this._pendingAttachments.map(a => ({
				id: a.id,
				label: a.label,
				kind: a.kind,
			})),
		});
	}

	private pushActivity(event: AgentActivityEvent, sessionId?: string) {
		const sid = sessionId ?? this._currentSessionId ?? undefined;
		const ui = sid ? this.uiFor(sid) : undefined;
		const messages = ui?.messages ?? this._messages;
		const timeline = ui?.timeline ?? this._timeline;
		const turn = ui?.currentTurn ?? this._currentTurn;
		const paint = (): void => {
			if (!sid || sid === this._currentSessionId) this.updateView();
		};
		// Thoughts are shown in the Reasoning accordion on the assistant message.
		if (event.kind === 'thought') {
			if (event.detail && sid) {
				appendAssistantThought(
					new Map([[sid, { messages }]]),
					sid,
					event.detail
				);
				const last = messages[messages.length - 1];
				const next = last?.reasoning ?? event.detail;
				if (ui) ui.turnReasoning = next;
				if (sid === this._currentSessionId) this._turnReasoning = next;
				paint();
			}
			return;
		}
		// Live wait label (Cursor-style): Thinking / Reading / Grepping / Planning…
		if (event.kind === 'thinking') {
			this.setPendingLiveStatus(event.label || 'Thinking…', sid);
			return;
		}
		if (event.kind === 'compact') {
			this.setPendingLiveStatus(event.label || 'Compacting…', sid);
			return;
		}
		if (event.kind === 'context') {
			this.setPendingLiveStatus(event.label || 'Loading context…', sid);
			return;
		}
		if (event.kind === 'checkpoint') {
			const label = String(event.label || '');
			if (/^Phase:\s*plan/i.test(label) || /\bplanning\b/i.test(label)) {
				this.setPendingLiveStatus('Planning…', sid);
			} else if (
				/Incomplete intent|Thin final|retry tools|ask for findings/i.test(label)
			) {
				this.setPendingLiveStatus(label, sid);
			}
			if (
				/^(hook|Lesson|Oracle|LLM |Repaired|Retry|Nuked|Switched|Parsed|Truncated|Build-fix|context |Phase:|Prior context|Turn summary|Stopped)/i.test(
					label
				) ||
				/\bindexed\b/i.test(label) ||
				/^contextBudget\b/i.test(label) ||
				/^Thinking/i.test(label)
			) {
				return;
			}
		}
		if (event.kind === 'tool') {
			if (event.toolStatus === 'running') {
				this.setPendingLiveStatus(event.label || `Running ${event.tool || 'tool'}…`, sid);
			} else if (event.toolStatus === 'ok' || event.toolStatus === 'failed' || event.success !== undefined) {
				this.setPendingLiveStatus('Thinking…', sid);
			}
		}
		if (event.kind === 'tool' && event.toolCallId) {
			const existing = timeline.find(
				t => t.kind === 'tool' && t.toolCallId === event.toolCallId
			);
			if (existing) {
				existing.label = event.label;
				existing.detail = event.detail;
				existing.success = event.success;
				existing.toolStatus = event.toolStatus;
				existing.ts = Date.now();
				existing.turn = turn;
				paint();
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
			turn,
			ts: Date.now(),
		};
		timeline.push(item);
		if (timeline.length > 120) {
			const trimmed = timeline.slice(-120);
			if (ui) ui.timeline = trimmed;
			if (!sid || sid === this._currentSessionId) this._timeline = trimmed;
		}
		paint();
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
		if (this.visibleBusy()) {
			void vscode.window.showWarningMessage('Stop the agent before undoing edits.');
			return;
		}
		const n = await getEditJournal().undoAllPending({
			write: (p, c) => this._bridge.writeRaw(p, c),
			delete: p => this._bridge.deleteRaw(p),
			readRaw: p => this._bridge.readRaw(p),
		});
		await this.refreshEditSummary();
		void vscode.window.showInformationMessage(
			n > 0 ? `Reverted ${n} file(s).` : 'No pending edits to undo.'
		);
	}

	private async reviewPendingEdits(): Promise<void> {
		const pending = getEditJournal().listPending();
		if (!pending.length) {
			void vscode.window.showInformationMessage('No pending edits to review.');
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
		if (this.visibleBusy()) {
			void vscode.window.showWarningMessage('Stop the agent before restoring a checkpoint.');
			return;
		}
		if (!Number.isFinite(messageIndex) || messageIndex < 0 || messageIndex >= this._messages.length) {
			void vscode.window.showWarningMessage('Could not find that message to restore.');
			return;
		}
		const msg = this._messages[messageIndex];
		if (msg.role !== 'user') {
			void vscode.window.showWarningMessage('Restore checkpoint only works on your messages.');
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
			void vscode.window.showErrorMessage(
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
		await this.refreshEditSummary();
		this.updateView();
		this.pushConfig();
		void this._view?.webview.postMessage({ type: 'restorePrompt', text: promptText });
		void vscode.window.showInformationMessage('Checkpoint restored — prompt is back in the input box.');
	}

	private async executeLocalAgent(
		task: string,
		images: Array<{ mime: string; dataUrl: string; label?: string }> = [],
		sessionId?: string,
		handle?: FlightHandle
	): Promise<string> {
		const sid = sessionId ?? this._currentSessionId;
		const flight = handle ?? (sid ? this._flights.get(sid) : undefined);
		const ui = sid ? this.uiFor(sid) : undefined;
		const runMode = ui?.mode ?? this._mode;
		const root = this._bridge.getWorkspaceRoot();
		let { server, model } = this._store.getActiveSelection();

		if (!server) {
			return [
				`No AI server configured.`,
				`Workspace: ${root ?? '(none — open a folder)'}`,
				``,
				`Add a server in Settings (⚙) or Command Palette → CodeForge AI: Settings.`,
				`Then pick a model with the chip above.`,
			].join('\n');
		}

		// A turn with image attachments must run against an image-capable model.
		// Resolve that automatically — same server if it already has one, otherwise
		// the first other configured, enabled server that does — before anything
		// below picks provider/apiKey/baseUrl/model for this call. A local setup
		// commonly keeps only one model process up at a time, so the resolved
		// server may be configured but not actually running right now: probe it
		// and drop the image (not the whole turn) rather than fail on a server
		// that isn't there to answer.
		if (images.length > 0) {
			const state = this._store.getState();
			const route = await resolveReachableVisionRoute(state, server.id, model);
			if (!route) {
				this._pendingImages = [];
				images = [];
				void vscode.window.showWarningMessage(
					'No vision-capable model is reachable right now — sending this turn without the attached image(s).'
				);
			} else if (!route.sameAsActive) {
				const routed = state.servers.find(s => s.id === route.serverId);
				if (routed) {
					this.setPendingLiveStatus(
						routed.id === server.id
							? `Using ${route.model} for the attached image…`
							: `Routing attached image to ${routed.name} (${route.model})…`
					);
					server = routed;
					model = route.model;
				}
			}
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

		const numCtx = await this.resolveNumCtx(server.id, server.numCtx, activeModel, baseUrl, apiKey);

		if (runMode === 'ask') {
			if (!apiKey && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
				return [
					`Ask mode — add an API key for ${server.name} in Settings.`,
					`Workspace: ${root ?? '(none)'}`,
				].join('\n');
			}
			const weakAsk = this.detectWeakHarness(server, activeModel);
			const cfgAsk = vscode.workspace.getConfiguration('codeforge.ai');
			return runAgentWithTools({
				bridge: this._bridge,
				provider,
				apiKey,
				model: activeModel,
				baseUrl,
				workspaceRoot: root,
				task,
				images,
				history: this.getHistoryForLlm(sid),
				cancelled: () => !!flight?.cancelled,
				abortSignal: flight?.abort.signal,
				numCtx,
				forceJson: server.forceJson === true,
				sampling: server.sampling,
				serverId: server.id,
				onStatus: text => this.setPendingLiveStatus(text, sid ?? undefined),
				onActivity: ev => this.observeActivity(ev, sid ?? undefined),
				onLoopExit: exit => {
					if (ui) ui.lastLoopExit = exit;
					if (sid === this._currentSessionId) this._lastLoopExit = exit;
				},
				onContextBadge: badge => {
					this._contextBadge = badge;
					this.pushConfig();
				},
				onContextUsage: usage => {
					if (ui) ui.contextUsage = usage;
					if (sid === this._currentSessionId) {
						this._contextUsage = usage;
						this.pushConfig();
					}
				},
				onTurnMetrics: metrics => this.applyTurnMetrics(metrics, sid ?? undefined),
				drainSteering: () => this.takeSteering(sid ?? undefined),
				sessionStore: this._sessions,
				sessionId: sid,
				turnIndex: ui?.currentTurn ?? this._currentTurn,
				onRegisterSubAbort: (subId, abort) => {
					if (sid) this._flights.registerSub(sid, subId, abort);
				},
				maxSteps: cfgAsk.get<number>('agentCheckpointSteps') ?? 20,
				hardCap: 40,
				weakProfile: weakAsk,
				askMode: true,
			});
		}

		const weakProfile = this.detectWeakHarness(server, activeModel);
		this._weakHarness = weakProfile;
		this.pushConfig();

		if (runMode === 'plan') {
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
				history: this.getHistoryForLlm(sid),
				cancelled: () => !!flight?.cancelled,
				abortSignal: flight?.abort.signal,
				numCtx,
				forceJson: server.forceJson === true,
				sampling: server.sampling,
				serverId: server.id,
				onStatus: text => this.setPendingLiveStatus(text, sid ?? undefined),
				onActivity: ev => this.observeActivity(ev, sid ?? undefined),
				onLoopExit: exit => {
					if (ui) ui.lastLoopExit = exit;
					if (sid === this._currentSessionId) this._lastLoopExit = exit;
				},
				onContextBadge: badge => {
					this._contextBadge = badge;
					this.pushConfig();
				},
				onContextUsage: usage => {
					if (ui) ui.contextUsage = usage;
					if (sid === this._currentSessionId) {
						this._contextUsage = usage;
						this.pushConfig();
					}
				},
				onTurnMetrics: metrics => this.applyTurnMetrics(metrics, sid ?? undefined),
				drainSteering: () => this.takeSteering(sid ?? undefined),
				onTaskUpdate: this._onTaskUpdate,
				sessionStore: this._sessions,
				sessionId: sid,
				turnIndex: ui?.currentTurn ?? this._currentTurn,
				onRegisterSubAbort: (subId, abort) => {
					if (sid) this._flights.registerSub(sid, subId, abort);
				},
				maxSteps: cfgAgentPlan.get<number>('agentCheckpointSteps') ?? 30,
				hardCap: cfgAgentPlan.get<number>('agentHardCap') ?? 100,
				weakProfile,
				planMode: true,
			});
		}

		// No keyword shortcuts that bypass the agent: Portuguese "lista"/"listar" contains
		// "list", so phrases like "lista … nesta pasta" used to dump the workspace root.

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
			history: this.getHistoryForLlm(sid),
			cancelled: () => !!flight?.cancelled,
			abortSignal: flight?.abort.signal,
			numCtx,
			forceJson: server.forceJson === true,
			sampling: server.sampling,
			serverId: server.id,
			onStatus: text => this.setPendingLiveStatus(text, sid ?? undefined),
			onActivity: ev => this.observeActivity(ev, sid ?? undefined),
			onLoopExit: exit => {
				if (ui) ui.lastLoopExit = exit;
				if (sid === this._currentSessionId) this._lastLoopExit = exit;
			},
			onContextBadge: badge => {
				this._contextBadge = badge;
				this.pushConfig();
			},
			onContextUsage: usage => {
				if (ui) ui.contextUsage = usage;
				if (sid === this._currentSessionId) {
					this._contextUsage = usage;
					this.pushConfig();
				}
			},
			onTurnMetrics: metrics => this.applyTurnMetrics(metrics, sid ?? undefined),
			drainSteering: () => this.takeSteering(sid ?? undefined),
			onTaskUpdate: this._onTaskUpdate,
			sessionStore: this._sessions,
			sessionId: sid,
			turnIndex: ui?.currentTurn ?? this._currentTurn,
			onRegisterSubAbort: (subId, abort) => {
				if (sid) this._flights.registerSub(sid, subId, abort);
			},
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

	private getHistoryForLlm(sessionId?: string | null): Array<{ role: 'user' | 'assistant'; content: string }> {
		const msgs = sessionId ? this.uiFor(sessionId).messages : this._messages;
		const completed = msgs.filter(m => m.status !== 'pending');
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
				Accept: 'text/event-stream, application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			signal: this._currentSessionId
				? this._flights.get(this._currentSessionId)?.abort.signal
				: undefined,
			body: JSON.stringify({
				model: provider === 'ollama' ? model || 'llama3.2' : model,
				messages: [
					{ role: 'system', content: system.length > 6000 ? system.slice(0, 6000) + '\n…' : system },
					...history,
					{ role: 'user', content: userContent },
				],
				temperature: 0.2,
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: 2048,
			}),
		});

		if (!response.ok) {
			throw new Error(`LLM error ${response.status}: ${await response.text()}`);
		}

		const ctype = (response.headers.get('content-type') || '').toLowerCase();
		const { server: askServer } = this._store.getActiveSelection();
		const configured = askServer?.numCtx && askServer.numCtx > 0 ? askServer.numCtx : undefined;
		const slots = askServer ? cachedLlamaSlots(askServer.id, model) : undefined;
		const limit = effectiveContextBudget(configured, slots) ?? 0;

		if (response.body && (ctype.includes('event-stream') || ctype.includes('octet-stream') || !ctype.includes('json'))) {
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let content = '';
			let lastUi = 0;
			let usage: { prompt_tokens?: number; input_tokens?: number } | undefined;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split(/\r?\n/);
				buffer = parts.pop() ?? '';
				for (const line of parts) {
					const t = line.trim();
					if (!t.startsWith('data:')) continue;
					const payload = t.slice(5).trim();
					if (!payload || payload === '[DONE]') continue;
					try {
						const chunk = JSON.parse(payload) as {
							usage?: { prompt_tokens?: number; input_tokens?: number };
							choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
						};
						if (chunk.usage) usage = chunk.usage;
						const piece =
							chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
						if (piece) {
							content += piece;
							const now = Date.now();
							if (now - lastUi >= 50) {
								lastUi = now;
								this.updateLastMessage('assistant', content, 'pending');
							}
						}
					} catch {
						/* skip */
					}
				}
			}
			const used = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
			if (used > 0 && limit > 0) {
				this._contextUsage = { used, limit };
				this.pushConfig();
			}
			return content || '(empty response)';
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
			signal: this._currentSessionId
				? this._flights.get(this._currentSessionId)?.abort.signal
				: undefined,
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
				if (this.visibleBusy()) {
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
				this.addMessage(
					'assistant',
					'Switched to Ask mode — read/search/web tools only (no edits or shell).'
				);
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

	private addMessage(
		role: 'user' | 'assistant',
		content: string,
		status?: string,
		sessionId?: string
	) {
		const { model } = this._store.getActiveSelection();
		const sid = sessionId ?? this._currentSessionId;
		const msgs = sid ? this.uiFor(sid).messages : this._messages;
		msgs.push({
			role,
			content,
			status,
			timestamp: new Date(),
			model: role === 'assistant' ? model : undefined,
		});
		if (!sid || sid === this._currentSessionId) this.updateView();
	}

	private updateLastMessage(
		role: 'user' | 'assistant',
		content: string,
		status?: string,
		extra?: { reasoning?: string; timings?: MessageTimings; continueAvailable?: boolean },
		sessionId?: string
	) {
		const sid = sessionId ?? this._currentSessionId;
		const msgs = sid ? this.uiFor(sid).messages : this._messages;
		const lastIndex = msgs.length - 1;
		if (lastIndex >= 0 && msgs[lastIndex]!.role === role) {
			msgs[lastIndex]!.content = content;
			msgs[lastIndex]!.status = status;
			if (status !== 'pending') {
				delete msgs[lastIndex]!.liveStatus;
			}
			if (extra?.reasoning !== undefined) {
				msgs[lastIndex]!.reasoning = extra.reasoning;
			}
			if (extra?.timings !== undefined) {
				msgs[lastIndex]!.timings = extra.timings;
			}
			if (extra?.continueAvailable) {
				msgs[lastIndex]!.continueAvailable = true;
			} else {
				delete msgs[lastIndex]!.continueAvailable;
			}
		}
		if (!sid || sid === this._currentSessionId) this.updateView();
	}

	/** Structured resume after step-budget exhaustion (Continue button — not text "continue"). */
	private async handleContinueTurn(): Promise<void> {
		if (this.visibleBusy()) return;
		const last = this._messages[this._messages.length - 1];
		if (last?.role === 'assistant') {
			delete last.continueAvailable;
			this.updateView();
		}
		await this.runTask(CONTINUE_TURN_PROMPT);
	}

	/**
	 * Muted live line while the agent works. Tool verbs stay short labels;
	 * streamed model prose becomes a brief narration (sense of motion on long turns).
	 * Cleared when the pending bubble leaves `pending` (see updateLastMessage).
	 */
	private setPendingLiveStatus(text: string, sessionId?: string): void {
		const sid = sessionId ?? this._currentSessionId;
		this._turnWaiters.observer(sid)?.onStatus(text);
		let cleaned = String(text || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (!cleaned) return;
		if (/^Thinking/i.test(cleaned)) cleaned = 'Thinking';
		else if (/^Working/i.test(cleaned) || /^Continuing/i.test(cleaned)) cleaned = 'Planning next moves';
		else if (/^Planning/i.test(cleaned)) cleaned = 'Planning next moves';
		else if (/^Oracle:/i.test(cleaned) || /Checking build/i.test(cleaned)) cleaned = 'Checking build';
		else if (/^Compacting/i.test(cleaned)) cleaned = 'Compacting context';
		else if (/^Loading context/i.test(cleaned)) cleaned = 'Gathering context';
		else if (/^Reading\b/i.test(cleaned)) {
			const file = cleaned.replace(/^Reading\s+/i, '').split(/[/\\]/).pop() || '';
			cleaned = file ? `Reading ${file}` : 'Reading files';
		} else if (/^Grepping\b/i.test(cleaned)) cleaned = 'Grepping';
		else if (/^Searching\b/i.test(cleaned)) cleaned = 'Searching codebase';
		else if (/^Listing\b/i.test(cleaned)) cleaned = 'Listing files';
		else if (/^Writing\b/i.test(cleaned)) cleaned = 'Writing files';
		else if (/^Editing\b/i.test(cleaned)) cleaned = 'Editing files';
		else if (/^Deleting\b|^Renaming\b|^Inspecting\b/i.test(cleaned)) cleaned = 'Updating files';
		else if (/^Running\b/i.test(cleaned)) cleaned = 'Running command';
		else if (/^Updating status/i.test(cleaned)) cleaned = 'Updating status';
		else if (/^\[(subagent|coach)\]/i.test(cleaned)) {
			cleaned = cleaned.replace(/^\[(subagent|coach)\]\s*/i, '').trim() || cleaned;
			cleaned = ChatViewProvider.liveNarrationSnippet(cleaned);
		} else {
			// Streamed assistant prose (or unknown status) — show intent, not a dead "Planning…" stub.
			cleaned = ChatViewProvider.liveNarrationSnippet(cleaned);
		}
		const msgs = sid ? this.uiFor(sid).messages : this._messages;
		const last = msgs[msgs.length - 1];
		if (!last || last.role !== 'assistant' || last.status !== 'pending') return;
		if (last.liveStatus === cleaned) return;
		last.liveStatus = cleaned.slice(0, 160);
		if (!sid || sid === this._currentSessionId) this.updateView();
	}

	/** Last sentence / trailing clause of streamed model text for the live status line. */
	private static liveNarrationSnippet(text: string): string {
		let t = String(text || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (!t) return 'Planning next moves';
		// Drop obvious tool-JSON / fence noise.
		if (/^[{[]/.test(t) || /^```/.test(t) || /"tool_calls"\s*:/.test(t)) {
			return 'Planning next moves';
		}
		const sentences = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
		let pick = sentences.length ? sentences[sentences.length - 1]! : t;
		if (pick.length < 16 && sentences.length > 1) {
			pick = sentences.slice(-2).join(' ');
		}
		// Prefer a trailing window when the model dumps a long paragraph without punctuation.
		if (pick.length > 140) {
			pick = '…' + pick.slice(-137).trimStart();
		}
		return pick || 'Planning next moves';
	}

	private applyTurnMetrics(
		metrics: {
			promptTokens?: number;
			completionTokens?: number;
			durationMs?: number;
			tokensPerSecond?: number;
			reasoning?: string;
		},
		sessionId?: string
	): void {
		const sid = sessionId ?? this._currentSessionId;
		const ui = sid ? this.uiFor(sid) : undefined;
		if (metrics.reasoning) {
			if (ui) ui.turnReasoning = metrics.reasoning;
			if (!sid || sid === this._currentSessionId) this._turnReasoning = metrics.reasoning;
		}
		if (
			metrics.promptTokens !== undefined ||
			metrics.completionTokens !== undefined ||
			metrics.durationMs !== undefined
		) {
			const timings = {
				promptTokens: metrics.promptTokens,
				completionTokens: metrics.completionTokens,
				durationMs: metrics.durationMs,
				tokensPerSecond: metrics.tokensPerSecond,
			};
			if (ui) ui.turnTimings = timings;
			if (!sid || sid === this._currentSessionId) this._turnTimings = timings;
		}
		const msgs = sid ? this.uiFor(sid).messages : this._messages;
		const last = msgs[msgs.length - 1];
		const reasoning = ui?.turnReasoning ?? this._turnReasoning;
		const timings = ui?.turnTimings ?? this._turnTimings;
		if (last?.role === 'assistant') {
			if (reasoning) last.reasoning = reasoning;
			if (timings) last.timings = timings;
			if (!sid || sid === this._currentSessionId) this.updateView();
		}
	}

	private updateView() {
		if (this._view) {
			const collapseToolCards =
				vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('collapseToolCards') !==
				false;
			void this._view.webview.postMessage({
				type: 'updateMessages',
				messages: this._messages,
				timeline: this._timeline,
				collapseToolCards,
				busy: this.visibleBusy(),
			});
		}
	}

	private readOpenTabs(): string[] {
		const raw = this._context?.workspaceState.get<string[]>(OPEN_TABS_KEY) ?? [];
		return raw.filter(id => !!this._sessions.get(id));
	}

	private persistOpenTabs(): void {
		void this._context?.workspaceState.update(OPEN_TABS_KEY, this._openSessionIds);
	}

	private ensureOpenTab(id: string): void {
		if (!id) return;
		if (!this._openSessionIds.includes(id)) {
			this._openSessionIds.push(id);
			this.persistOpenTabs();
		}
	}

	private pushTabs(): void {
		if (!this._view) return;
		const open = this._openSessionIds
			.map(id => {
				const s = this._sessions.get(id);
				if (!s) return null;
				return { id: s.id, title: s.title || 'Chat' };
			})
			.filter((t): t is { id: string; title: string } => !!t);
		this._openSessionIds = open.map(t => t.id);
		this.persistOpenTabs();
		void this._view.webview.postMessage({
			type: 'tabs',
			open,
			active: this._currentSessionId,
			busy: this.visibleBusy(),
			running: this.runningIds(),
		});
	}

	private async switchTab(id: string): Promise<void> {
		if (!id || id === this._currentSessionId) return;
		await this.loadSession(id, { reveal: false });
	}

	private async closeTab(id: string): Promise<void> {
		if (!id) return;
		if (this._flights.has(id)) {
			this._flights.abort(id);
		}
		const idx = this._openSessionIds.indexOf(id);
		if (idx < 0) return;
		this._openSessionIds.splice(idx, 1);
		this.persistOpenTabs();
		if (id === this._currentSessionId) {
			const next = this._openSessionIds[idx] ?? this._openSessionIds[idx - 1];
			if (next) {
				await this.loadSession(next);
			} else {
				this.newChat();
			}
		} else {
			this.pushTabs();
		}
	}

	private async branchAt(messageIndex: number): Promise<void> {
		if (this.visibleBusy()) {
			void vscode.window.showWarningMessage('Stop the agent before branching.');
			return;
		}
		if (!this._currentSessionId) {
			void vscode.window.showWarningMessage('Nothing to branch yet.');
			return;
		}
		const forked = await this._sessions.forkFrom(this._currentSessionId, messageIndex);
		if (!forked) {
			void vscode.window.showWarningMessage('Could not branch at that message.');
			return;
		}
		this.ensureOpenTab(forked.id);
		await this.loadSession(forked.id);
		void vscode.window.showInformationMessage(`Opened branch: ${forked.title}`);
	}

	private async regenerateAt(messageIndex: number): Promise<void> {
		if (this.visibleBusy()) {
			void vscode.window.showWarningMessage('Stop the agent before regenerating.');
			return;
		}
		if (
			!Number.isFinite(messageIndex) ||
			messageIndex < 0 ||
			messageIndex >= this._messages.length
		) {
			return;
		}
		const msg = this._messages[messageIndex];
		if (msg.role !== 'assistant') return;

		let userIndex = -1;
		for (let i = messageIndex - 1; i >= 0; i--) {
			if (this._messages[i].role === 'user') {
				userIndex = i;
				break;
			}
		}
		if (userIndex < 0) return;

		const promptText =
			this._messages[userIndex].content.split(/\n\n(?:Attached |Images:|---)/)[0]?.trim() ||
			this._messages[userIndex].content;
		const userTurn =
			this._messages.slice(0, userIndex + 1).filter(m => m.role === 'user').length - 1;

		if (this._currentSessionId) {
			await this._sessions.truncateFrom(this._currentSessionId, userIndex);
		}
		this._messages = this._messages.slice(0, userIndex);
		this._timeline = this._timeline.filter(
			t => t.turn !== undefined && t.turn !== null && t.turn < userTurn
		);
		this._currentTurn = Math.max(0, userTurn - 1);
		this.updateView();
		await this.runTask(promptText);
	}

	private async runPython(code: string): Promise<void> {
		if (this._pythonProc) {
			void vscode.window.showWarningMessage('A Python run is already in progress.');
			return;
		}
		this.stopPython();
		const trimmed = code.trim();
		const confirmRun =
			vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('confirmRunPython') === true;
		if (confirmRun) {
			const ok = await vscode.window.showWarningMessage(
				'Run this Python snippet from the chat?',
				{ modal: true },
				'Run'
			);
			if (ok !== 'Run') {
				void this._view?.webview.postMessage({
					type: 'pythonResult',
					ok: false,
					output: 'Run cancelled.',
				});
				return;
			}
		}
		if (!trimmed) {
			void this._view?.webview.postMessage({
				type: 'pythonResult',
				ok: false,
				output: 'No code to run.',
			});
			return;
		}
		const tmp = path.join(os.tmpdir(), `codeforge-py-${Date.now()}.py`);
		try {
			await fs.writeFile(tmp, trimmed, 'utf8');
		} catch (err) {
			void this._view?.webview.postMessage({
				type: 'pythonResult',
				ok: false,
				output: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		const cmd = process.platform === 'win32' ? 'py' : 'python3';
		const args = process.platform === 'win32' ? ['-3', tmp] : [tmp];
		let proc: ChildProcessWithoutNullStreams;
		try {
			proc = spawn(cmd, args, {
				cwd: this._bridge.getWorkspaceRoot() || os.tmpdir(),
				env: process.env,
			});
		} catch {
			try {
				proc = spawn('python', [tmp], {
					cwd: this._bridge.getWorkspaceRoot() || os.tmpdir(),
					env: process.env,
				});
			} catch (err) {
				void this._view?.webview.postMessage({
					type: 'pythonResult',
					ok: false,
					output: err instanceof Error ? err.message : String(err),
				});
				void fs.unlink(tmp).catch(() => undefined);
				return;
			}
		}

		this._pythonProc = proc;
		void this._view?.webview.postMessage({ type: 'pythonStatus', running: true });
		let output = '';
		proc.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			void this._view?.webview.postMessage({ type: 'pythonChunk', text: chunk.toString() });
		});
		proc.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			void this._view?.webview.postMessage({ type: 'pythonChunk', text: chunk.toString() });
		});
		proc.on('close', code => {
			this._pythonProc = undefined;
			void fs.unlink(tmp).catch(() => undefined);
			void this._view?.webview.postMessage({
				type: 'pythonResult',
				ok: code === 0,
				output: output || `(exit ${code ?? '?'})`,
				exitCode: code,
			});
		});
		proc.on('error', err => {
			this._pythonProc = undefined;
			void fs.unlink(tmp).catch(() => undefined);
			void this._view?.webview.postMessage({
				type: 'pythonResult',
				ok: false,
				output: err.message,
			});
		});
	}

	private stopPython(): void {
		if (this._pythonProc) {
			try {
				this._pythonProc.kill();
			} catch {
				/* ignore */
			}
			this._pythonProc = undefined;
			void this._view?.webview.postMessage({
				type: 'pythonResult',
				ok: false,
				output: 'Stopped.',
			});
		}
	}

	private _getHtmlContent(): string {
		const webview = this._view!.webview;
		const asUri = (...parts: string[]) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...parts)).toString();
		const base = ['resources', 'webview'] as const;
		return getChatViewHtml({
			cspSource: webview.cspSource,
			cspNonce: randomBytes(16).toString('base64'),
			markedJs: asUri(...base, 'marked.umd.js'),
			hljsJs: asUri(...base, 'highlight.min.js'),
			dompurifyJs: asUri(...base, 'purify.min.js'),
			hljsCss: asUri(...base, 'github-dark.min.css'),
			katexJs: asUri(...base, 'katex.min.js'),
			katexCss: asUri(...base, 'katex.min.css'),
			katexAutoRenderJs: asUri(...base, 'katex-auto-render.min.js'),
			mermaidJs: asUri(...base, 'mermaid.min.js'),
		});
	}
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
