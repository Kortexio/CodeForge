/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kortexio. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { autorun, constObservable, derived, IObservable, ISettableObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IChatModelReference, IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { resolveModelIdentifier } from '../../../../../workbench/contrib/chat/common/modelSelection.js';
import {
	ChatInteractivity,
	ChatModelSource,
	IChat,
	ISession,
	ISessionCapabilities,
	ISessionFileChange,
	ISessionType,
	ISessionWorkspace,
	ISessionWorkspaceBrowseAction,
	ISideChatSelection,
	SESSION_WORKSPACE_GROUP_LOCAL,
	SessionStatus,
	SessionTypeAuthRequirement,
	toSessionId,
} from '../../../../services/sessions/common/session.js';
import {
	IDeleteChatOptions,
	ISendRequestOptions,
	ISessionChangeEvent,
	ISessionModelPickerOptions,
	ISessionModelsSnapshot,
	ISessionsProvider,
} from '../../../../services/sessions/common/sessionsProvider.js';
import {
	CODEFORGE_LM_VENDOR,
	CODEFORGE_PARTICIPANT_ID,
	CodeForgeHarnessCommands,
	CodeForgeMode,
	CodeForgePermission,
	codeforgeLanguageModels,
	harnessModelIdOf,
	ICodeForgeHarnessState,
	languageModelIdentifierOf,
	parseHarnessState,
} from '../common/codeforgeHarness.js';

export const CODEFORGE_PROVIDER_ID = 'codeforge';

export const CodeForgeSessionType: ISessionType = {
	id: 'codeforge',
	label: localize('codeforgeSessionType', "CodeForge"),
	icon: Codicon.flame,
	authRequirement: SessionTypeAuthRequirement.None,
};

const STORAGE_KEY = 'codeforge.agents.sessions.v1';
const SESSION_SCHEME = 'codeforge-agents-session';

interface IStoredSession {
	readonly id: string;
	readonly chatResource: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly workspace?: string;
	readonly archived?: boolean;
	readonly modelId?: string;
	readonly mode?: CodeForgeMode;
}

function modeKind(mode: CodeForgeMode): string {
	return mode === 'ask' ? 'ask' : 'agent';
}

/** A CodeForge session in the Agents window: one chat backed by a local chat model. */
class CodeForgeSession extends Disposable implements ISession {

	readonly sessionId: string;
	readonly resource: URI;
	readonly providerId = CODEFORGE_PROVIDER_ID;
	readonly sessionType = CodeForgeSessionType.id;
	readonly icon = CodeForgeSessionType.icon;
	readonly createdAt: Date;

	private readonly _title: ISettableObservable<string>;
	readonly title: IObservable<string>;
	private readonly _updatedAt: ISettableObservable<Date>;
	readonly updatedAt: IObservable<Date>;
	private readonly _status = observableValue<SessionStatus>(this, SessionStatus.Untitled);
	readonly status: IObservable<SessionStatus> = this._status;
	private readonly _workspace: ISettableObservable<ISessionWorkspace | undefined>;
	readonly workspace: IObservable<ISessionWorkspace | undefined>;
	readonly changes: IObservable<readonly ISessionFileChange[]> = constObservable([]);
	readonly changesets = constObservable(undefined);
	private readonly _modelId: ISettableObservable<string | undefined>;
	readonly modelId: IObservable<string | undefined>;
	private readonly _modelSource = observableValue<ChatModelSource | undefined>(this, undefined);
	private readonly _mode: ISettableObservable<{ readonly id: string; readonly kind: string } | undefined>;
	readonly mode: IObservable<{ readonly id: string; readonly kind: string } | undefined>;
	readonly loading = constObservable(false);
	private readonly _isArchived: ISettableObservable<boolean>;
	readonly isArchived: IObservable<boolean>;
	private readonly _isRead = observableValue(this, true);
	readonly isRead: IObservable<boolean> = this._isRead;
	private readonly _description = observableValue<IMarkdownString | undefined>(this, undefined);
	readonly description: IObservable<IMarkdownString | undefined> = this._description;
	private readonly _lastTurnEnd = observableValue<Date | undefined>(this, undefined);
	readonly lastTurnEnd: IObservable<Date | undefined> = this._lastTurnEnd;
	readonly mainChat: IObservable<IChat>;
	readonly chats: IObservable<readonly IChat[]>;
	readonly capabilities: IObservable<ISessionCapabilities> = constObservable({
		supportsMultipleChats: false,
		supportsRename: true,
		supportsDelete: true,
	});

	private readonly _modelBinding = this._register(new DisposableStore());
	private _boundModel: IChatModel | undefined;

	constructor(
		readonly localId: string,
		readonly chatResource: URI,
		stored: Partial<IStoredSession>,
		workspace: ISessionWorkspace | undefined,
		private readonly _onDidChange: () => void,
	) {
		super();
		this.resource = URI.from({ scheme: SESSION_SCHEME, path: `/${localId}` });
		this.sessionId = toSessionId(CODEFORGE_PROVIDER_ID, this.resource);
		this.createdAt = new Date(stored.createdAt ?? Date.now());
		this._title = observableValue(this, stored.title ?? '');
		this.title = this._title;
		this._updatedAt = observableValue(this, new Date(stored.updatedAt ?? Date.now()));
		this.updatedAt = this._updatedAt;
		this._workspace = observableValue(this, workspace);
		this.workspace = this._workspace;
		this._modelId = observableValue(this, stored.modelId);
		this.modelId = this._modelId;
		this._mode = observableValue(this, stored.mode ? { id: stored.mode, kind: modeKind(stored.mode) } : undefined);
		this.mode = this._mode;
		this._isArchived = observableValue(this, stored.archived === true);
		this.isArchived = this._isArchived;
		if (stored.title !== undefined) {
			this._status.set(SessionStatus.Completed, undefined);
		}

		const chat: IChat = {
			resource: chatResource,
			createdAt: this.createdAt,
			title: this.title,
			updatedAt: this.updatedAt,
			status: this.status,
			changes: this.changes,
			checkpoints: constObservable(undefined),
			modelId: this.modelId,
			modelSource: this._modelSource,
			mode: this.mode,
			isArchived: this.isArchived,
			isRead: this.isRead,
			interactivity: constObservable(ChatInteractivity.Full),
			description: this.description,
			lastTurnEnd: this.lastTurnEnd,
		};
		this.mainChat = constObservable(chat);
		this.chats = derived(reader => [this.mainChat.read(reader)]);
	}

	get isDraft(): boolean {
		return this._status.get() === SessionStatus.Untitled;
	}

	/** Mirrors the chat model's request state onto the session status. */
	bindModel(model: IChatModel): void {
		if (this._boundModel === model) {
			return;
		}
		this._modelBinding.clear();
		this._boundModel = model;
		this._modelBinding.add(autorun(reader => {
			const inProgress = model.requestInProgress.read(reader);
			const needsInput = model.requestNeedsInput.read(reader);
			if (this.isDraft && !model.hasRequests) {
				return;
			}
			transaction(tx => {
				if (needsInput) {
					this._status.set(SessionStatus.NeedsInput, tx);
				} else if (inProgress) {
					this._status.set(SessionStatus.InProgress, tx);
				} else {
					const last = model.lastRequest?.response;
					const failed = !!last?.result?.errorDetails;
					this._status.set(failed ? SessionStatus.Error : SessionStatus.Completed, tx);
					this._description.set(failed ? new MarkdownString(last?.result?.errorDetails?.message ?? '') : undefined, tx);
					if (last?.isComplete) {
						this._lastTurnEnd.set(new Date(), tx);
					}
				}
				this._updatedAt.set(new Date(), tx);
			});
			this._onDidChange();
		}));
	}

	setTitle(title: string): void {
		this._title.set(title, undefined);
	}

	setStatus(status: SessionStatus, description?: string): void {
		transaction(tx => {
			this._status.set(status, tx);
			this._description.set(description ? new MarkdownString(description) : undefined, tx);
		});
	}

	setModel(modelId: string | undefined, source: ChatModelSource | undefined): void {
		transaction(tx => {
			this._modelSource.set(modelId ? source : undefined, tx);
			this._modelId.set(modelId, tx);
		});
	}

	setMode(mode: CodeForgeMode): void {
		this._mode.set({ id: mode, kind: modeKind(mode) }, undefined);
	}

	setArchived(archived: boolean): void {
		this._isArchived.set(archived, undefined);
	}

	setRead(isRead: boolean): void {
		this._isRead.set(isRead, undefined);
	}

	toStored(): IStoredSession {
		const mode = this._mode.get()?.id;
		return {
			id: this.localId,
			chatResource: this.chatResource.toString(),
			title: this._title.get(),
			createdAt: this.createdAt.getTime(),
			updatedAt: this._updatedAt.get().getTime(),
			workspace: this._workspace.get()?.uri.toString(),
			archived: this._isArchived.get() || undefined,
			modelId: this._modelId.get(),
			mode: mode === 'ask' || mode === 'plan' || mode === 'agent' ? mode : undefined,
		};
	}
}

/**
 * Sessions provider for the Agents window backed by the CodeForge harness.
 * Each session is one local chat whose turns go to the `codeforge.agent`
 * participant, which runs the same pipeline as the CodeForge side chat.
 */
export class CodeForgeSessionsProvider extends Disposable implements ISessionsProvider {

	readonly id = CODEFORGE_PROVIDER_ID;
	readonly label = localize('codeforgeProvider', "CodeForge");
	readonly icon = Codicon.flame;
	readonly order = -1;
	readonly sessionTypes: readonly ISessionType[] = [CodeForgeSessionType];
	readonly onDidChangeSessionTypes: Event<void> = Event.None;
	readonly browseActions: readonly ISessionWorkspaceBrowseAction[] = [];
	readonly supportsLocalWorkspaces = true;
	readonly supportsQuickChats = false;

	private readonly _onDidChangeSessions = this._register(new Emitter<ISessionChangeEvent>());
	readonly onDidChangeSessions: Event<ISessionChangeEvent> = this._onDidChangeSessions.event;

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _harness = observableValue<ICodeForgeHarnessState | undefined>(this, undefined);
	/** Latest harness state from the CodeForge extension, or `undefined` while it is not connected. */
	readonly harness: IObservable<ICodeForgeHarnessState | undefined> = this._harness;

	private readonly _sessions = this._register(new DisposableMap<string, CodeForgeSession>());
	private readonly _drafts = this._register(new DisposableMap<string, CodeForgeSession>());
	private readonly _chatRefs = this._register(new DisposableMap<string, IChatModelReference>());

	constructor(
		@IChatService private readonly chatService: IChatService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super();
		this._restore();
		this._register(this.chatService.onDidCreateModel(model => this._bindIfOwned(model)));
		this._register(this.languageModelsService.onDidChangeLanguageModels(vendor => {
			if (vendor === CODEFORGE_LM_VENDOR) {
				this._onDidChangeModels.fire();
			}
		}));
		this._register(CommandsRegistry.onDidRegisterCommand(id => {
			if (id === CodeForgeHarnessCommands.GetState) {
				void this.refreshHarness();
			}
		}));
		void this.refreshHarness();
	}

	// -- Harness state --

	async refreshHarness(): Promise<void> {
		if (!CommandsRegistry.getCommand(CodeForgeHarnessCommands.GetState)) {
			return;
		}
		try {
			const raw = await this.commandService.executeCommand(CodeForgeHarnessCommands.GetState);
			this._harness.set(parseHarnessState(raw), undefined);
		} catch (error) {
			this.logService.warn('[CodeForgeSessionsProvider] Could not read harness state', error);
			this._harness.set(undefined, undefined);
		}
		// Registering a vendor does not resolve its models; selecting by vendor does.
		await this.languageModelsService.selectLanguageModels({ vendor: CODEFORGE_LM_VENDOR });
		this._onDidChangeModels.fire();
	}

	async setHarnessMode(mode: CodeForgeMode): Promise<void> {
		this._harness.set(parseHarnessState(await this.commandService.executeCommand(CodeForgeHarnessCommands.SetMode, mode)), undefined);
	}

	async setHarnessPermission(level: CodeForgePermission): Promise<void> {
		this._harness.set(parseHarnessState(await this.commandService.executeCommand(CodeForgeHarnessCommands.SetPermission, level)), undefined);
	}

	async setFullAgentFreedom(enabled: boolean): Promise<void> {
		this._harness.set(parseHarnessState(await this.commandService.executeCommand(CodeForgeHarnessCommands.SetFullAgentFreedom, enabled)), undefined);
	}

	// -- Persistence --

	private _restore(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}
		let entries: IStoredSession[];
		try {
			entries = JSON.parse(raw);
		} catch (error) {
			this.logService.warn('[CodeForgeSessionsProvider] Ignoring unreadable session list', error);
			return;
		}
		for (const entry of Array.isArray(entries) ? entries : []) {
			if (typeof entry?.id !== 'string' || typeof entry.chatResource !== 'string') {
				continue;
			}
			const workspace = entry.workspace ? this.resolveWorkspace(URI.parse(entry.workspace)) : undefined;
			const session = new CodeForgeSession(entry.id, URI.parse(entry.chatResource), entry, workspace, () => this._persist());
			this._sessions.set(session.sessionId, session);
			const live = this.chatService.getSession(session.chatResource);
			if (live) {
				session.bindModel(live);
			}
		}
	}

	private _persist(): void {
		const entries = [...this._sessions.values()].map(s => s.toStored());
		this.storageService.store(STORAGE_KEY, JSON.stringify(entries), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private _bindIfOwned(model: IChatModel): void {
		const key = model.sessionResource.toString();
		for (const session of [...this._sessions.values(), ...this._drafts.values()]) {
			if (session.chatResource.toString() === key) {
				session.bindModel(model);
				return;
			}
		}
	}

	private _find(sessionId: string): CodeForgeSession | undefined {
		return this._drafts.get(sessionId) ?? this._sessions.get(sessionId);
	}

	private _require(sessionId: string): CodeForgeSession {
		const session = this._find(sessionId);
		if (!session) {
			throw new Error(`CodeForge session '${sessionId}' not found`);
		}
		return session;
	}

	// -- Sessions --

	getSessions(): ISession[] {
		return [...this._sessions.values()];
	}

	getSessionTypes(workspaceUri: URI): ISessionType[] {
		return workspaceUri.scheme === Schemas.file ? [CodeForgeSessionType] : [];
	}

	resolveWorkspace(uri: URI): ISessionWorkspace | undefined {
		if (uri.scheme !== Schemas.file) {
			return undefined;
		}
		return {
			uri,
			label: basename(uri),
			description: dirname(uri).fsPath,
			group: SESSION_WORKSPACE_GROUP_LOCAL,
			icon: Codicon.folder,
			folders: [{ root: uri, workingDirectory: uri, name: basename(uri), description: undefined }],
			requiresWorkspaceTrust: true,
			isVirtualWorkspace: false,
		};
	}

	createNewSession(workspaceUri: URI, sessionTypeId: string): ISession {
		if (sessionTypeId !== CodeForgeSessionType.id) {
			throw new Error(`Unsupported session type '${sessionTypeId}' for CodeForge`);
		}
		const workspace = this.resolveWorkspace(workspaceUri);
		if (!workspace) {
			throw new Error(`CodeForge sessions need a local folder, got ${workspaceUri.toString()}`);
		}
		const ref = this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { debugOwner: 'CodeForgeSessionsProvider' });
		const harness = this._harness.get();
		const session = new CodeForgeSession(generateUuid(), ref.object.sessionResource, {
			modelId: harness?.activeModelId ? languageModelIdentifierOf(harness.activeModelId) : undefined,
			mode: harness?.mode,
		}, workspace, () => this._persist());
		session.bindModel(ref.object);
		this._drafts.set(session.sessionId, session);
		this._chatRefs.set(session.sessionId, ref);
		return session;
	}

	createQuickChat(_sessionTypeId: string): ISession {
		throw new Error('CodeForge sessions are bound to a folder; quick chats are not offered');
	}

	deleteNewSession(sessionId: string): void {
		if (this._drafts.has(sessionId)) {
			this._drafts.deleteAndDispose(sessionId);
			this._chatRefs.deleteAndDispose(sessionId);
		}
	}

	async createNewChat(sessionId: string, _prompt?: string): Promise<IChat> {
		const session = this._require(sessionId);
		if (!session.isDraft) {
			throw new Error('CodeForge sessions have a single chat');
		}
		return session.mainChat.get();
	}

	async forkChat(sessionId: string, _sourceChat: URI, _turnId: string): Promise<IChat> {
		throw new Error(`Session '${sessionId}' does not support forking`);
	}

	async createSideChat(sessionId: string, _sourceChat: URI, _turnId: string, _selection?: ISideChatSelection): Promise<IChat> {
		throw new Error(`Session '${sessionId}' does not support side chats`);
	}

	async sendRequest(sessionId: string, chatResource: URI, options: ISendRequestOptions): Promise<ISession> {
		const session = this._require(sessionId);
		if (session.chatResource.toString() !== chatResource.toString()) {
			throw new Error(`Chat '${chatResource.toString()}' does not belong to session '${sessionId}'`);
		}
		await this._syncHarnessFor(session);

		if (session.isDraft) {
			session.setTitle((options.title || options.query.split('\n')[0]).substring(0, 100) || localize('newSession', "New Session"));
			session.setStatus(SessionStatus.InProgress);
			this._drafts.deleteAndLeak(sessionId);
			this._sessions.set(sessionId, session);
			this._persist();
			this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
		} else {
			session.setStatus(SessionStatus.InProgress);
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
		}

		const activeModelId = this._harness.get()?.activeModelId;
		const userSelectedModelId = activeModelId ? languageModelIdentifierOf(activeModelId) : undefined;
		const result = await this.chatService.sendRequest(chatResource, options.query, {
			location: ChatAgentLocation.Chat,
			agentIdSilent: CODEFORGE_PARTICIPANT_ID,
			userSelectedModelId: userSelectedModelId && this.languageModelsService.lookupLanguageModel(userSelectedModelId) ? userSelectedModelId : undefined,
			attachedContext: options.attachedContext,
			hideFromTranscript: options.hideFromTranscript,
		});
		if (result.kind === 'rejected') {
			session.setStatus(SessionStatus.Error, result.reason);
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
			throw new Error(`CodeForge request rejected: ${result.reason}`);
		}
		return session;
	}

	/** The harness has one active model and mode; align them with this session before its turn. */
	private async _syncHarnessFor(session: CodeForgeSession): Promise<void> {
		const harness = this._harness.get();
		if (!harness) {
			return;
		}
		const selected = session.modelId.get();
		const modelId = selected ? harnessModelIdOf(selected) : undefined;
		if (modelId && modelId !== harness.activeModelId && harness.models.some(m => m.id === modelId)) {
			this._harness.set(parseHarnessState(await this.commandService.executeCommand(CodeForgeHarnessCommands.SetModel, modelId)), undefined);
		}
		const mode = session.mode.get()?.id;
		if ((mode === 'ask' || mode === 'plan' || mode === 'agent') && mode !== harness.mode) {
			await this.setHarnessMode(mode);
		}
	}

	// -- Models --

	getModelsSnapshot(_sessionId: string, desiredModelId?: string): ISessionModelsSnapshot {
		const harness = this._harness.get();
		const models = codeforgeLanguageModels(harness, identifier => this.languageModelsService.lookupLanguageModel(identifier));
		return {
			models,
			desiredModelResolution: resolveModelIdentifier(models, desiredModelId, harness !== undefined),
			modelTarget: undefined,
		};
	}

	getModelPickerOptions(_sessionId: string): ISessionModelPickerOptions {
		return {
			useGroupedModelPicker: false,
			showFeatured: false,
			showUnavailableFeatured: false,
			showManageModelsAction: true,
			showAutoModel: false,
		};
	}

	setModel(sessionId: string, _chatResource: URI, modelId: string, source: ChatModelSource): void {
		const session = this._require(sessionId);
		session.setModel(modelId, source);
		if (!session.isDraft) {
			this._persist();
		}
		const harnessModelId = harnessModelIdOf(modelId);
		if (source === ChatModelSource.Chosen && harnessModelId && harnessModelId !== this._harness.get()?.activeModelId) {
			this.commandService.executeCommand(CodeForgeHarnessCommands.SetModel, harnessModelId).then(
				raw => this._harness.set(parseHarnessState(raw), undefined),
				error => this.logService.error('[CodeForgeSessionsProvider] Could not set the CodeForge model', error),
			);
		}
	}

	setMode(sessionId: string, modeId: string): void {
		if (modeId !== 'ask' && modeId !== 'plan' && modeId !== 'agent') {
			throw new Error(`Unknown CodeForge mode '${modeId}'`);
		}
		const session = this._require(sessionId);
		session.setMode(modeId);
		if (!session.isDraft) {
			this._persist();
		}
		this.setHarnessMode(modeId).catch(error => this.logService.error('[CodeForgeSessionsProvider] Could not set the CodeForge mode', error));
	}

	setPermissionLevel(_sessionId: string, level: string): void {
		if (level !== 'default' && level !== 'assisted' && level !== 'allowAll') {
			throw new Error(`Unknown CodeForge permission level '${level}'`);
		}
		this.setHarnessPermission(level).catch(error => this.logService.error('[CodeForgeSessionsProvider] Could not set the CodeForge permission level', error));
	}

	// -- Session management --

	async renameChat(sessionId: string, _chatUri: URI, title: string): Promise<void> {
		await this.renameSession(sessionId, title);
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const session = this._require(sessionId);
		session.setTitle(title);
		this._persist();
		this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
	}

	async archiveSession(sessionId: string): Promise<void> {
		this._setArchived(sessionId, true);
	}

	async unarchiveSession(sessionId: string): Promise<void> {
		this._setArchived(sessionId, false);
	}

	private _setArchived(sessionId: string, archived: boolean): void {
		const session = this._require(sessionId);
		session.setArchived(archived);
		this._persist();
		this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
	}

	async setSessionReadState(sessionId: string, isRead: boolean): Promise<void> {
		const session = this._require(sessionId);
		session.setRead(isRead);
		this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.deleteSessions([sessionId]);
	}

	async deleteSessions(sessionIds: readonly string[]): Promise<void> {
		const removed: ISession[] = [];
		for (const sessionId of sessionIds) {
			const session = this._sessions.get(sessionId);
			if (!session) {
				continue;
			}
			removed.push(session);
			await this.chatService.removeHistoryEntry(session.chatResource);
			this._sessions.deleteAndLeak(sessionId);
			this._chatRefs.deleteAndDispose(sessionId);
		}
		if (removed.length) {
			this._persist();
			this._onDidChangeSessions.fire({ added: [], removed, changed: [] });
			for (const session of removed) {
				(session as CodeForgeSession).dispose();
			}
		}
	}

	async deleteChat(_sessionId: string, _chatUri: URI, _options?: IDeleteChatOptions): Promise<boolean> {
		// Single-chat sessions: the main chat lives and dies with its session.
		return false;
	}
}

export function registerHarnessStateChangedCommand(getProvider: () => CodeForgeSessionsProvider | undefined): IDisposable {
	return CommandsRegistry.registerCommand(CodeForgeHarnessCommands.StateChanged, () => getProvider()?.refreshHarness());
}