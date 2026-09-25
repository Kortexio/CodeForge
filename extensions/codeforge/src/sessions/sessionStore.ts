/**
 * Persist AI chat sessions to ~/.CodeForge/ai/sessions/ (with globalState migration).
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StableFacts, normalizeFacts } from '../agent/stableFacts';
import { ensureDir, ensureHomeLayout, sessionDir, sessionsDir } from '../storage/paths';
import { getSessionWikiStore } from '../memory/sessionWiki';
import { salvageSessionProgress } from '../agent/projectStatus';

export type SessionState = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';

export interface SessionMessage {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
}

export interface ToolTraceEntry {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	output: string;
	success: boolean;
	error?: string;
	durationMs: number;
	timestamp: string;
}

export interface SessionCheckpoint {
	id: string;
	reason: string;
	createdAt: string;
	messageCount: number;
	toolTraceCount: number;
	rollingSummary?: string;
	pendingToolCall?: {
		name: string;
		arguments: Record<string, unknown>;
	};
}

export interface ChatSession {
	id: string;
	title: string;
	task: string;
	state: SessionState;
	messages: SessionMessage[];
	toolTraces: ToolTraceEntry[];
	checkpoints: SessionCheckpoint[];
	rollingSummary?: string;
	stableFacts?: StableFacts;
	workspaceFolder?: string;
	createdAt: string;
	updatedAt: string;
	model?: string;
	serverName?: string;
}

const STORAGE_KEY = 'codeforge.ai.sessions.v2';
const LEGACY_KEY = 'codeforge.ai.sessions.v1';
const ACTIVE_KEY = 'codeforge.ai.activeSessionId';
const MAX_SESSIONS = 100;
const INDEX_FILE = 'index.json';

export class SessionStore {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private cache: ChatSession[] | null = null;
	private ready: Promise<void>;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.ready = this.bootstrap();
	}

	private async bootstrap(): Promise<void> {
		await ensureHomeLayout();
		await this.migrateFromGlobalState();
		await this.loadFromDisk();
	}

	private async ensureReady(): Promise<void> {
		await this.ready;
	}

	list(opts?: { workspaceOnly?: boolean }): ChatSession[] {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let sessions = [...(this.cache ?? [])].map(normalizeSession);
		if (opts?.workspaceOnly && workspace) {
			sessions = sessions.filter(
				s => !s.workspaceFolder || s.workspaceFolder === workspace
			);
		}
		return sessions.sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
	}

	get(id: string): ChatSession | undefined {
		return this.list().find(s => s.id === id);
	}

	getActiveId(): string | undefined {
		return this.context.globalState.get<string>(ACTIVE_KEY);
	}

	async setActiveId(id: string | null): Promise<void> {
		await this.context.globalState.update(ACTIVE_KEY, id ?? undefined);
	}

	latest(): ChatSession | undefined {
		return this.list({ workspaceOnly: true })[0] ?? this.list()[0];
	}

	async create(partial: {
		task: string;
		model?: string;
		serverName?: string;
	}): Promise<ChatSession> {
		await this.ensureReady();
		const now = new Date().toISOString();
		const session: ChatSession = {
			id: randomUUID(),
			title: truncate(partial.task, 80),
			task: partial.task,
			state: 'running',
			messages: [],
			toolTraces: [],
			checkpoints: [],
			workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			createdAt: now,
			updatedAt: now,
			model: partial.model,
			serverName: partial.serverName,
		};
		const all = this.list();
		all.unshift(session);
		await this.persist(all.slice(0, MAX_SESSIONS));
		await this.setActiveId(session.id);
		await getSessionWikiStore().ensure(session.id, partial.task);
		return session;
	}

	async appendMessage(
		id: string,
		role: 'user' | 'assistant',
		content: string
	): Promise<ChatSession | undefined> {
		await this.ensureReady();
		const all = this.list();
		const idx = all.findIndex(s => s.id === id);
		if (idx < 0) return undefined;
		const session = all[idx];
		session.messages.push({
			role,
			content,
			timestamp: new Date().toISOString(),
		});
		session.updatedAt = new Date().toISOString();
		if (role === 'user' && session.messages.filter(m => m.role === 'user').length === 1) {
			session.title = truncate(content, 80);
			session.task = content;
		}
		all.splice(idx, 1);
		all.unshift(session);
		await this.persist(all);
		return session;
	}

	async appendToolTrace(
		id: string,
		entry: Omit<ToolTraceEntry, 'id' | 'timestamp'> & { id?: string }
	): Promise<void> {
		await this.ensureReady();
		const all = this.list();
		const session = all.find(s => s.id === id);
		if (!session) return;
		session.toolTraces.push({
			...entry,
			id: entry.id || randomUUID(),
			timestamp: new Date().toISOString(),
		});
		session.updatedAt = new Date().toISOString();
		await this.persist(all);
	}

	async createCheckpoint(
		id: string,
		reason: string,
		pendingToolCall?: SessionCheckpoint['pendingToolCall'],
		opts?: { pause?: boolean }
	): Promise<SessionCheckpoint | undefined> {
		await this.ensureReady();
		const all = this.list();
		const session = all.find(s => s.id === id);
		if (!session) return undefined;
		const checkpoint: SessionCheckpoint = {
			id: randomUUID(),
			reason,
			createdAt: new Date().toISOString(),
			messageCount: session.messages.length,
			toolTraceCount: session.toolTraces.length,
			rollingSummary: session.rollingSummary,
			pendingToolCall,
		};
		session.checkpoints.push(checkpoint);
		if (opts?.pause !== false && !reason.startsWith('approval:')) {
			session.state = 'paused';
		} else if (opts?.pause === true) {
			session.state = 'paused';
		}
		session.updatedAt = new Date().toISOString();
		await this.persist(all);
		return checkpoint;
	}

	async setRollingSummary(id: string, summary: string): Promise<void> {
		await this.ensureReady();
		const all = this.list();
		const session = all.find(s => s.id === id);
		if (!session) return;
		session.rollingSummary = summary;
		session.updatedAt = new Date().toISOString();
		await this.persist(all);
	}

	async setStableFacts(id: string, facts: StableFacts): Promise<void> {
		await this.ensureReady();
		const all = this.list();
		const session = all.find(s => s.id === id);
		if (!session) return;
		session.stableFacts = normalizeFacts(facts);
		session.updatedAt = new Date().toISOString();
		await this.persist(all);
		await getSessionWikiStore().setStableFacts(id, session.stableFacts);
	}

	async updateState(id: string, state: SessionState): Promise<void> {
		await this.ensureReady();
		const all = this.list();
		const session = all.find(s => s.id === id);
		if (!session) return;
		session.state = state;
		session.updatedAt = new Date().toISOString();
		await this.persist(all);
	}

	async remove(id: string): Promise<void> {
		await this.ensureReady();
		const session = this.list().find(s => s.id === id);
		await this.keepProjectProgress(session);
		await this.persist(this.list().filter(s => s.id !== id));
		try {
			await fs.rm(sessionDir(id), { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		if (this.getActiveId() === id) {
			await this.setActiveId(null);
		}
	}

	async clear(): Promise<void> {
		await this.ensureReady();
		const sessions = this.list();
		for (const session of sessions) {
			await this.keepProjectProgress(session);
		}
		await this.persist([]);
		await this.setActiveId(null);
		for (const session of sessions) {
			try {
				await fs.rm(sessionDir(session.id), { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	/** Chat is disposable. The stop point stays in the workspace memory file. */
	private async keepProjectProgress(session: ChatSession | undefined): Promise<void> {
		if (!session?.workspaceFolder) return;
		let plan = '';
		let blockers = '';
		try {
			const wiki = await getSessionWikiStore().load(session.id);
			plan = wiki.workingMemory.plan.join('; ');
			blockers = wiki.workingMemory.blockers.join('; ');
		} catch {
			/* session wiki is optional */
		}
		const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
		await salvageSessionProgress({
			workspaceFolder: session.workspaceFolder,
			task: session.task,
			rollingSummary: session.rollingSummary,
			lastAssistant: lastAssistant?.content,
			plan,
			blockers,
		});
	}

	async exportSession(id: string): Promise<string | undefined> {
		await this.ensureReady();
		const session = this.get(id);
		if (!session) return undefined;
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(`CodeForge-session-${id.slice(0, 8)}.json`),
			filters: { JSON: ['json'] },
		});
		if (!uri) return undefined;
		await fs.writeFile(uri.fsPath, JSON.stringify(session, null, 2), 'utf8');
		return uri.fsPath;
	}

	async importSession(filePath: string): Promise<ChatSession | undefined> {
		await this.ensureReady();
		const raw = await fs.readFile(filePath, 'utf8');
		const parsed = normalizeSession(JSON.parse(raw) as ChatSession);
		parsed.id = randomUUID();
		parsed.updatedAt = new Date().toISOString();
		parsed.workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const all = this.list();
		all.unshift(parsed);
		await this.persist(all.slice(0, MAX_SESSIONS));
		await this.setActiveId(parsed.id);
		return parsed;
	}

	private async migrateFromGlobalState(): Promise<void> {
		const indexPath = path.join(sessionsDir(), INDEX_FILE);
		try {
			await fs.access(indexPath);
			return; // disk already has data
		} catch {
			/* migrate */
		}
		let legacy = this.context.globalState.get<ChatSession[]>(STORAGE_KEY);
		if (!legacy?.length) {
			const v1 = this.context.globalState.get<Array<Partial<ChatSession>>>(LEGACY_KEY);
			if (v1?.length) {
				legacy = v1.map(s => normalizeSession(s as ChatSession));
			}
		}
		if (legacy?.length) {
			this.cache = legacy.map(normalizeSession);
			await this.persist(this.cache);
			await this.context.globalState.update(STORAGE_KEY, undefined);
			await this.context.globalState.update(LEGACY_KEY, undefined);
		}
	}

	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await fs.readFile(path.join(sessionsDir(), INDEX_FILE), 'utf8');
			const ids = JSON.parse(raw) as string[];
			const sessions: ChatSession[] = [];
			for (const id of ids.slice(0, MAX_SESSIONS)) {
				try {
					const body = await fs.readFile(path.join(sessionDir(id), 'session.json'), 'utf8');
					sessions.push(normalizeSession(JSON.parse(body) as ChatSession));
				} catch {
					/* skip missing */
				}
			}
			this.cache = sessions;
		} catch {
			this.cache = this.cache ?? [];
		}
	}

	private async persist(sessions: ChatSession[]): Promise<void> {
		this.cache = sessions;
		await ensureDir(sessionsDir());
		const ids: string[] = [];
		for (const session of sessions.slice(0, MAX_SESSIONS)) {
			ids.push(session.id);
			const dir = await ensureDir(sessionDir(session.id));
			await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
		}
		await fs.writeFile(path.join(sessionsDir(), INDEX_FILE), JSON.stringify(ids, null, 2), 'utf8');
		this._onDidChange.fire();
	}
}

function normalizeSession(s: ChatSession): ChatSession {
	return {
		...s,
		toolTraces: s.toolTraces ?? [],
		checkpoints: s.checkpoints ?? [],
		messages: s.messages ?? [],
		stableFacts: s.stableFacts ? normalizeFacts(s.stableFacts) : undefined,
	};
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}
