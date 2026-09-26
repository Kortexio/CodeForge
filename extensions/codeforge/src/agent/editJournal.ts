/**
 * Tracks agent file edits per session/turn so the chat can Undo All, Review, and Restore checkpoint.
 * Shell-side edits are not recorded.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export interface JournalFileEntry {
	/** Workspace-relative path (forward slashes). */
	path: string;
	/** Content before first write in this turn; null when the file was created. */
	originalContent: string | null;
	turn: number;
	sessionId: string;
	kind: 'create' | 'modify' | 'delete';
}

export interface JournalSummary {
	files: number;
	added: number;
	removed: number;
	paths: string[];
}

type ReadRaw = (filePath: string) => Promise<string | undefined>;
type WriteRaw = (filePath: string, content: string) => Promise<void>;
type DeleteRaw = (filePath: string) => Promise<void>;

export class EditJournal {
	private entries: JournalFileEntry[] = [];
	private sessionId: string | null = null;
	private turn = 0;
	/** Turns whose pending bar has been accepted (implicit accept on next send). */
	private acceptedTurns = new Set<number>();
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	setContext(sessionId: string, turn: number): void {
		this.sessionId = sessionId;
		this.turn = turn;
	}

	getTurn(): number {
		return this.turn;
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	clearSession(sessionId?: string): void {
		if (sessionId && this.sessionId && this.sessionId !== sessionId) return;
		this.entries = [];
		this.acceptedTurns.clear();
		this.sessionId = null;
		this.turn = 0;
		this._onDidChange.fire();
	}

	/**
	 * Capture original content once per path per turn, before the write/edit/delete.
	 */
	async recordBeforeWrite(
		filePath: string,
		readRaw: ReadRaw,
		opts?: { deleting?: boolean }
	): Promise<void> {
		if (!this.sessionId) return;
		const rel = normalizeRel(filePath);
		const keyTurn = this.turn;
		if (this.entries.some(e => e.sessionId === this.sessionId && e.turn === keyTurn && e.path === rel)) {
			return;
		}
		const existing = await readRaw(filePath);
		const deleting = opts?.deleting === true;
		const kind: JournalFileEntry['kind'] = deleting
			? 'delete'
			: existing === undefined
				? 'create'
				: 'modify';
		this.entries.push({
			path: rel,
			originalContent: existing === undefined ? null : existing,
			turn: keyTurn,
			sessionId: this.sessionId,
			kind,
		});
		this._onDidChange.fire();
	}

	/** Pending = turns not yet accepted, for the current session. */
	listPending(): JournalFileEntry[] {
		if (!this.sessionId) return [];
		return this.entries.filter(
			e => e.sessionId === this.sessionId && !this.acceptedTurns.has(e.turn)
		);
	}

	listFromTurn(fromTurn: number): JournalFileEntry[] {
		if (!this.sessionId) return [];
		return this.entries.filter(e => e.sessionId === this.sessionId && e.turn >= fromTurn);
	}

	getOriginal(relPath: string, turn?: number): string | null | undefined {
		const rel = normalizeRel(relPath);
		const candidates = this.entries
			.filter(e => e.path === rel && (turn === undefined || e.turn === turn))
			.sort((a, b) => a.turn - b.turn);
		return candidates[0]?.originalContent;
	}

	async summary(readRaw: ReadRaw): Promise<JournalSummary> {
		const pending = this.listPending();
		const byPath = new Map<string, JournalFileEntry>();
		for (const e of pending) {
			if (!byPath.has(e.path)) byPath.set(e.path, e);
		}
		let added = 0;
		let removed = 0;
		for (const e of byPath.values()) {
			const current = await readRaw(e.path);
			const before = e.originalContent ?? '';
			const after = current ?? '';
			const diff = lineDiffCounts(before, after);
			added += diff.added;
			removed += diff.removed;
		}
		return {
			files: byPath.size,
			added,
			removed,
			paths: [...byPath.keys()],
		};
	}

	/** Mark all current pending turns as accepted (hides the bar). */
	accept(): void {
		for (const e of this.listPending()) {
			this.acceptedTurns.add(e.turn);
		}
		this._onDidChange.fire();
	}

	/**
	 * Revert all edits from `fromTurn` onward (inclusive), newest first.
	 * Removes those journal entries afterward.
	 */
	async revertTurns(
		fromTurn: number,
		ops: { write: WriteRaw; delete: DeleteRaw; readRaw: ReadRaw }
	): Promise<number> {
		if (!this.sessionId) return 0;
		const sid = this.sessionId;
		const toRevert = this.entries
			.filter(e => e.sessionId === sid && e.turn >= fromTurn)
			.sort((a, b) => b.turn - a.turn || b.path.localeCompare(a.path));

		// First original per path in ascending turn order (for restore)
		const firstByPath = new Map<string, JournalFileEntry>();
		for (const e of [...toRevert].sort((a, b) => a.turn - b.turn)) {
			if (!firstByPath.has(e.path)) firstByPath.set(e.path, e);
		}

		for (const e of firstByPath.values()) {
			if (e.originalContent === null) {
				try {
					await ops.delete(e.path);
				} catch {
					/* may already be gone */
				}
			} else {
				await ops.write(e.path, e.originalContent);
			}
		}

		this.entries = this.entries.filter(e => !(e.sessionId === sid && e.turn >= fromTurn));
		for (const t of [...this.acceptedTurns]) {
			if (t >= fromTurn) this.acceptedTurns.delete(t);
		}
		this._onDidChange.fire();
		return firstByPath.size;
	}

	async undoAllPending(ops: { write: WriteRaw; delete: DeleteRaw; readRaw: ReadRaw }): Promise<number> {
		const pending = this.listPending();
		if (!pending.length) return 0;
		const minTurn = Math.min(...pending.map(e => e.turn));
		return this.revertTurns(minTurn, ops);
	}
}

function normalizeRel(filePath: string): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let p = filePath.replace(/\\/g, '/');
	if (root) {
		const rootNorm = root.replace(/\\/g, '/');
		if (p.toLowerCase().startsWith(rootNorm.toLowerCase() + '/') || p.toLowerCase() === rootNorm.toLowerCase()) {
			p = p.slice(rootNorm.length).replace(/^\//, '');
		}
	}
	return p.replace(/^\.\//, '');
}

function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	// Simple LCS-free heuristic: count line-length delta when one side empty, else abs diff of lengths.
	if (!before && after) return { added: b.length, removed: 0 };
	if (before && !after) return { added: 0, removed: a.length };
	const max = Math.max(a.length, b.length);
	let added = 0;
	let removed = 0;
	for (let i = 0; i < max; i++) {
		const left = a[i];
		const right = b[i];
		if (left === undefined) added++;
		else if (right === undefined) removed++;
		else if (left !== right) {
			added++;
			removed++;
		}
	}
	return { added, removed };
}

const ORIGINAL_SCHEME = 'codeforge-original';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly journal: EditJournal) {}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const rel = decodeURIComponent(uri.path.replace(/^\//, ''));
		const original = this.journal.getOriginal(rel);
		if (original === undefined) return '';
		if (original === null) return '';
		return original;
	}

	static uriFor(relPath: string): vscode.Uri {
		return vscode.Uri.from({
			scheme: ORIGINAL_SCHEME,
			path: '/' + relPath.replace(/\\/g, '/'),
		});
	}

	static get scheme(): string {
		return ORIGINAL_SCHEME;
	}
}

/** Shared journal used by the chat view and the workspace bridge. */
let sharedJournal: EditJournal | undefined;

export function getEditJournal(): EditJournal {
	if (!sharedJournal) {
		sharedJournal = new EditJournal();
	}
	return sharedJournal;
}

export function initEditJournal(): EditJournal {
	sharedJournal = new EditJournal();
	return sharedJournal;
}

/** Absolute or relative path → workspace-relative for diffs. */
export function toWorkspaceRel(filePath: string): string {
	return normalizeRel(filePath);
}

export function absFromRel(relPath: string): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) return relPath;
	if (path.isAbsolute(relPath)) return relPath;
	return path.join(root, relPath);
}
