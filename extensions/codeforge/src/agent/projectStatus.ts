/**
 * Project handoff — written every turn by the harness (or via update_status), read on the next turn.
 * Lives under {workspace}/.CodeForge/memory/; sessions do not own it.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir, projectMemoryDir } from '../storage/paths';
import { clipData } from './clip';

export const STATUS_FILENAME = 'status.json';
export const STATUS_MD_FILENAME = 'status.md';
export const HISTORY_MAX = 20;
export const DIGEST_MAX = 2000;

export type StatusSource = 'model' | 'harness';
export type StatusOutcome = 'done' | 'blocked' | 'max-steps' | 'cancelled' | 'error';

export interface StatusRepoSnapshot {
	head: string;
	branch: string;
	dirty: string[];
}

export interface StatusRef {
	path: string;
	why: string;
}

export interface StatusEntry {
	updatedAt: string;
	source: StatusSource;
	objective: string;
	stoppedAt: string;
	next: string;
	blockers: string;
	files: string[];
	outcome: StatusOutcome;
	repo?: StatusRepoSnapshot;
	refs?: StatusRef[];
}

export interface ProjectStatusFile {
	version: 2;
	current: StatusEntry;
	history: StatusEntry[];
	digest: string;
}

/** Flat v1 shape still accepted on load. */
export interface ProjectStatus {
	updatedAt: string;
	objective: string;
	stoppedAt: string;
	next: string;
	blockers: string;
	files: string[];
}

export function emptyStatusPrompt(): string {
	return [
		'## PROJECT STATUS',
		'No status file yet (.CodeForge/memory/status.json).',
		'This block is where the work stopped. Answer that from here; do not scan the repo for it.',
		'Before the final reply, call update_status.',
	].join('\n');
}

export function normalizeEntry(input: Partial<StatusEntry> & { objective?: string; stoppedAt?: string }): StatusEntry {
	const files = (input.files ?? []).map(f => String(f).trim()).filter(Boolean).slice(0, 24);
	const refs = (input.refs ?? [])
		.map(r => ({ path: String(r.path ?? '').trim(), why: String(r.why ?? '').trim().slice(0, 160) }))
		.filter(r => r.path)
		.slice(0, 12);
	const dirty = (input.repo?.dirty ?? []).map(d => String(d).trim()).filter(Boolean).slice(0, 12);
	return {
		updatedAt: input.updatedAt || new Date().toISOString(),
		source: input.source === 'model' ? 'model' : 'harness',
		objective: (input.objective ?? '').trim().slice(0, 500),
		stoppedAt: (input.stoppedAt ?? '').trim().slice(0, 800),
		next: (input.next ?? '').trim().slice(0, 500),
		blockers: (input.blockers ?? '').trim().slice(0, 500),
		files,
		outcome: normalizeOutcome(input.outcome),
		repo: input.repo
			? {
					head: String(input.repo.head ?? '').trim().slice(0, 64),
					branch: String(input.repo.branch ?? '').trim().slice(0, 120),
					dirty,
				}
			: undefined,
		refs: refs.length ? refs : undefined,
	};
}

function normalizeOutcome(o: unknown): StatusOutcome {
	if (o === 'blocked' || o === 'max-steps' || o === 'cancelled' || o === 'error' || o === 'done') return o;
	return 'done';
}

/** Promote flat v1 / partial objects into a v2 file. */
export function normalizeStatusFile(data: unknown): ProjectStatusFile | null {
	if (!data || typeof data !== 'object') return null;
	const raw = data as Record<string, unknown>;
	if (raw.version === 2 && raw.current && typeof raw.current === 'object') {
		const current = normalizeEntry(raw.current as Partial<StatusEntry>);
		const history = Array.isArray(raw.history)
			? (raw.history as Partial<StatusEntry>[]).map(normalizeEntry).slice(0, HISTORY_MAX)
			: [];
		return {
			version: 2,
			current,
			history,
			digest: String(raw.digest ?? '').trim().slice(0, DIGEST_MAX),
		};
	}
	if (typeof raw.stoppedAt === 'string' || typeof raw.objective === 'string') {
		const current = normalizeEntry({
			updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
			objective: String(raw.objective ?? ''),
			stoppedAt: String(raw.stoppedAt ?? ''),
			next: String(raw.next ?? ''),
			blockers: String(raw.blockers ?? ''),
			files: Array.isArray(raw.files) ? raw.files.map(String) : [],
			source: 'harness',
			outcome: 'done',
		});
		return { version: 2, current, history: [], digest: '' };
	}
	return null;
}

/** Flat view used by older callers (salvage, simple tests). */
export function normalizeStatus(input: {
	objective?: string;
	stoppedAt?: string;
	next?: string;
	blockers?: string;
	files?: string[];
	updatedAt?: string;
}): ProjectStatus {
	const e = normalizeEntry(input);
	return {
		updatedAt: e.updatedAt,
		objective: e.objective,
		stoppedAt: e.stoppedAt,
		next: e.next,
		blockers: e.blockers,
		files: e.files,
	};
}

export function buildDigest(opts: {
	rollingSummary?: string;
	entries: StatusEntry[];
}): string {
	const rolling = (opts.rollingSummary ?? '').trim();
	if (rolling) return clipData(rolling, DIGEST_MAX);
	const lines = opts.entries
		.map(e => e.stoppedAt.trim())
		.filter(Boolean)
		.slice(0, 12);
	if (!lines.length) return '';
	return clipData(lines.join('\n'), DIGEST_MAX);
}

export function formatStatusForPrompt(
	file: ProjectStatusFile,
	opts?: { liveRepo?: StatusRepoSnapshot | null }
): string {
	const cur = file.current;
	const stale = stalenessLine(cur.repo, opts?.liveRepo);
	const files = cur.files.filter(Boolean);
	const historyLines = file.history
		.slice(0, 5)
		.map(h => `- ${h.updatedAt.slice(0, 10)}: ${h.stoppedAt || '(empty)'}`)
		.filter(Boolean);
	const refs = (cur.refs ?? []).map(r => `- ${r.path}: ${r.why}`).filter(Boolean);
	return [
		'## PROJECT STATUS',
		stale,
		`Updated: ${cur.updatedAt}`,
		`Source: ${cur.source} · outcome: ${cur.outcome}`,
		`Objective: ${cur.objective || '(none)'}`,
		`Stopped at: ${cur.stoppedAt || '(none)'}`,
		`Next: ${cur.next || '(none)'}`,
		cur.blockers ? `Blockers: ${cur.blockers}` : '',
		files.length ? `Files: ${files.join(', ')}` : '',
		refs.length ? `Refs:\n${refs.join('\n')}` : '',
		file.digest ? `### Digest\n${file.digest}` : '',
		historyLines.length ? `### Earlier stops\n${historyLines.join('\n')}` : '',
		'Answer where the work stopped from this block. Before the final reply, call update_status.',
	]
		.filter(Boolean)
		.join('\n');
}

export function stalenessLine(
	saved?: StatusRepoSnapshot,
	live?: StatusRepoSnapshot | null
): string {
	if (!saved?.head || !live?.head) return '';
	if (saved.head === live.head) {
		const savedDirty = new Set(saved.dirty);
		const liveDirty = live.dirty;
		const changed = liveDirty.filter(d => !savedDirty.has(d));
		if (!changed.length && saved.dirty.length === liveDirty.length) return '';
		if (!changed.length) return '';
		return `Note: working tree changed since this status (${changed.slice(0, 6).join(', ')}). Treat Stopped at as prior to those edits.`;
	}
	return `Note: status is from ${saved.branch || 'unknown'}@${saved.head.slice(0, 8)}; HEAD is now ${live.branch || 'unknown'}@${live.head.slice(0, 8)}. Treat Stopped at as prior to later commits.`;
}

export function formatStatusMarkdown(file: ProjectStatusFile): string {
	const cur = file.current;
	const lines = [
		'# Project status',
		'',
		`Updated: ${cur.updatedAt}`,
		`Source: ${cur.source} · outcome: ${cur.outcome}`,
		'',
		`**Objective:** ${cur.objective || '(none)'}`,
		'',
		`**Stopped at:** ${cur.stoppedAt || '(none)'}`,
		'',
		`**Next:** ${cur.next || '(none)'}`,
	];
	if (cur.blockers) {
		lines.push('', `**Blockers:** ${cur.blockers}`);
	}
	if (cur.files.length) {
		lines.push('', `**Files:** ${cur.files.join(', ')}`);
	}
	if (cur.refs?.length) {
		lines.push('', '## Refs', ...cur.refs.map(r => `- \`${r.path}\` — ${r.why}`));
	}
	if (file.digest) {
		lines.push('', '## Digest', '', file.digest);
	}
	if (file.history.length) {
		lines.push('', '## Earlier stops');
		for (const h of file.history.slice(0, 10)) {
			lines.push(`- ${h.updatedAt}: ${h.stoppedAt || '(empty)'}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

/** Final reply waits until this run called update_status (isolated sub-runs keep their own plan). */
export function shouldRequireStatusUpdate(opts: {
	isolated?: boolean;
	alreadyUpdated: boolean;
	nudges: number;
}): boolean {
	if (opts.isolated) return false;
	if (opts.alreadyUpdated) return false;
	return opts.nudges < 1;
}

export function shouldWriteHandoff(opts: { isolated?: boolean; depth?: number }): boolean {
	if (opts.isolated) return false;
	if ((opts.depth ?? 0) > 0) return false;
	return true;
}

function statusPath(workspaceRoot?: string): string {
	return path.join(projectMemoryDir(workspaceRoot), STATUS_FILENAME);
}

function statusMdPath(workspaceRoot?: string): string {
	return path.join(projectMemoryDir(workspaceRoot), STATUS_MD_FILENAME);
}

export async function loadProjectStatus(workspaceRoot?: string): Promise<ProjectStatusFile | null> {
	try {
		const raw = await fs.readFile(statusPath(workspaceRoot), 'utf8');
		return normalizeStatusFile(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Flat current for callers that only need objective/stoppedAt (salvage). */
export async function loadProjectStatusFlat(workspaceRoot?: string): Promise<ProjectStatus | null> {
	const file = await loadProjectStatus(workspaceRoot);
	if (!file) return null;
	const c = file.current;
	return {
		updatedAt: c.updatedAt,
		objective: c.objective,
		stoppedAt: c.stoppedAt,
		next: c.next,
		blockers: c.blockers,
		files: c.files,
	};
}

let writeChain: Promise<void> = Promise.resolve();

async function writeAtomic(filePath: string, body: string): Promise<void> {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, body, 'utf8');
	try {
		await fs.rename(tmp, filePath);
	} catch {
		await fs.writeFile(filePath, body, 'utf8');
		await fs.unlink(tmp).catch(() => undefined);
	}
}

export interface AppendStatusInput {
	objective?: string;
	stoppedAt?: string;
	next?: string;
	blockers?: string;
	files?: string[];
	source?: StatusSource;
	outcome?: StatusOutcome;
	repo?: StatusRepoSnapshot;
	refs?: StatusRef[];
	rollingSummary?: string;
	/** When true and model already wrote this turn, only merge outcome/files onto current. */
	mergeOntoCurrent?: boolean;
}

/**
 * Append a handoff entry (or merge onto current). Serialised per process; atomic rename.
 */
export async function appendProjectStatus(
	workspaceRoot: string | undefined,
	input: AppendStatusInput
): Promise<ProjectStatusFile> {
	const run = writeChain.then(() => appendProjectStatusUnlocked(workspaceRoot, input));
	writeChain = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

async function appendProjectStatusUnlocked(
	workspaceRoot: string | undefined,
	input: AppendStatusInput
): Promise<ProjectStatusFile> {
	const dir = await ensureDir(projectMemoryDir(workspaceRoot));
	const existing = await loadProjectStatus(workspaceRoot);
	const entry = normalizeEntry({
		objective: input.objective,
		stoppedAt: input.stoppedAt,
		next: input.next,
		blockers: input.blockers,
		files: input.files,
		source: input.source,
		outcome: input.outcome,
		repo: input.repo,
		refs: input.refs,
	});

	let current: StatusEntry;
	let history: StatusEntry[];
	if (input.mergeOntoCurrent && existing?.current) {
		current = normalizeEntry({
			...existing.current,
			outcome: input.outcome ?? existing.current.outcome,
			files: uniqPaths([...(input.files ?? []), ...existing.current.files]),
			blockers: input.blockers || existing.current.blockers,
			repo: input.repo ?? existing.current.repo,
			refs: input.refs ?? existing.current.refs,
			updatedAt: new Date().toISOString(),
		});
		history = existing.history;
	} else if (existing?.current) {
		history = [existing.current, ...existing.history].slice(0, HISTORY_MAX);
		current = entry;
	} else {
		history = [];
		current = entry;
	}

	const digest = buildDigest({
		rollingSummary: input.rollingSummary,
		entries: [current, ...history],
	});
	const file: ProjectStatusFile = { version: 2, current, history, digest };
	await writeAtomic(path.join(dir, STATUS_FILENAME), JSON.stringify(file, null, 2));
	await writeAtomic(path.join(dir, STATUS_MD_FILENAME), formatStatusMarkdown(file));
	return file;
}

/** Convenience: model update_status → append as model source. */
export async function saveProjectStatus(
	workspaceRoot: string | undefined,
	input: {
		objective?: string;
		stoppedAt?: string;
		next?: string;
		blockers?: string;
		files?: string[];
		outcome?: StatusOutcome;
		repo?: StatusRepoSnapshot;
		refs?: StatusRef[];
		rollingSummary?: string;
	}
): Promise<StatusEntry> {
	const file = await appendProjectStatus(workspaceRoot, {
		...input,
		source: 'model',
		outcome: input.outcome ?? 'done',
	});
	return file.current;
}

function uniqPaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		const k = p.replace(/\\/g, '/').toLowerCase();
		if (!p.trim() || seen.has(k)) continue;
		seen.add(k);
		out.push(p.trim());
		if (out.length >= 24) break;
	}
	return out;
}

/**
 * Mechanical handoff when the model did not call update_status (or to merge outcome/files).
 */
export function buildHarnessEntry(input: {
	task: string;
	actionsSummary: string;
	reviewLog?: string;
	files: string[];
	openErrors?: string[];
	outcome: StatusOutcome;
	blockedReason?: string;
	repo?: StatusRepoSnapshot;
	refs?: StatusRef[];
}): StatusEntry {
	const stopped =
		[input.actionsSummary, input.reviewLog].filter(Boolean).join(' · ').trim() ||
		'Turn ended without a model status update.';
	return normalizeEntry({
		source: 'harness',
		objective: input.task,
		stoppedAt: stopped.slice(0, 800),
		next: input.outcome === 'done' ? '' : 'Continue from the stop point above.',
		blockers: input.blockedReason || (input.openErrors ?? []).slice(0, 5).join('; '),
		files: input.files,
		outcome: input.outcome,
		repo: input.repo,
		refs: input.refs,
	});
}

export async function finishTurn(opts: {
	workspaceRoot?: string;
	isolated?: boolean;
	depth?: number;
	task: string;
	modelUpdated: boolean;
	modelEntry?: Partial<StatusEntry>;
	actionsSummary: string;
	reviewLog?: string;
	files: string[];
	openErrors?: string[];
	outcome: StatusOutcome;
	blockedReason?: string;
	repo?: StatusRepoSnapshot;
	refs?: StatusRef[];
	rollingSummary?: string;
}): Promise<'skipped' | 'written' | 'merged'> {
	if (!shouldWriteHandoff({ isolated: opts.isolated, depth: opts.depth })) return 'skipped';
	if (!opts.workspaceRoot) return 'skipped';

	if (opts.modelUpdated) {
		await appendProjectStatus(opts.workspaceRoot, {
			mergeOntoCurrent: true,
			outcome: opts.outcome,
			files: opts.files,
			blockers: opts.blockedReason || (opts.openErrors ?? []).slice(0, 5).join('; '),
			repo: opts.repo,
			refs: opts.refs,
			rollingSummary: opts.rollingSummary,
		});
		return 'merged';
	}

	const entry = buildHarnessEntry({
		task: opts.task,
		actionsSummary: opts.actionsSummary,
		reviewLog: opts.reviewLog,
		files: opts.files,
		openErrors: opts.openErrors,
		outcome: opts.outcome,
		blockedReason: opts.blockedReason,
		repo: opts.repo,
		refs: opts.refs,
	});
	await appendProjectStatus(opts.workspaceRoot, {
		...entry,
		rollingSummary: opts.rollingSummary,
	});
	return 'written';
}

/**
 * Session delete removes the chat only. If the project file has no stop point yet,
 * copy the session's last progress into the workspace file first.
 */
export async function salvageSessionProgress(input: {
	workspaceFolder?: string;
	task?: string;
	rollingSummary?: string;
	lastAssistant?: string;
	plan?: string;
	blockers?: string;
}): Promise<'kept' | 'written' | 'skipped'> {
	const root = input.workspaceFolder?.trim();
	if (!root) return 'skipped';
	const existing = await loadProjectStatus(root);
	if (existing?.current?.stoppedAt) return 'kept';
	const stoppedAt = (input.rollingSummary || input.lastAssistant || input.plan || '').trim();
	const objective = (input.task || '').trim();
	if (!stoppedAt && !objective) return 'skipped';
	await appendProjectStatus(root, {
		source: 'harness',
		outcome: 'cancelled',
		objective,
		stoppedAt: stoppedAt || 'Session closed before a stop point was written.',
		next: '',
		blockers: (input.blockers || '').trim(),
		files: existing?.current?.files ?? [],
		rollingSummary: input.rollingSummary,
	});
	return 'written';
}

/** Discover plan / BUGS / cards / AGENTS paths that exist (refs only, no bodies). */
export async function discoverStatusRefs(workspaceRoot?: string): Promise<StatusRef[]> {
	if (!workspaceRoot) return [];
	const candidates: Array<{ path: string; why: string }> = [
		{ path: '.CodeForge/memory/plan.json', why: 'orchestrator plan' },
		{ path: 'BUGS.md', why: 'review findings' },
		{ path: 'AGENTS.md', why: 'project agent instructions' },
	];
	const refs: StatusRef[] = [];
	for (const c of candidates) {
		try {
			await fs.access(path.join(workspaceRoot, c.path));
			refs.push(c);
		} catch {
			/* missing */
		}
	}
	try {
		const docs = path.join(workspaceRoot, 'docs');
		const names = await fs.readdir(docs);
		for (const name of names.filter(n => /^C\d+/i.test(n) && n.endsWith('.md')).slice(0, 6)) {
			refs.push({ path: `docs/${name}`, why: 'card' });
		}
	} catch {
		/* no docs */
	}
	return refs.slice(0, 12);
}

/**
 * Parse `git status --short --branch` and `git rev-parse HEAD` style outputs into a snapshot.
 * Pure — callers supply the strings (keeps this module free of vscode).
 */
export function parseRepoSnapshot(opts: {
	head?: string;
	statusShort?: string;
}): StatusRepoSnapshot | undefined {
	const head = (opts.head ?? '').trim();
	if (!head || head === '(empty)') return undefined;
	const lines = (opts.statusShort ?? '').split(/\r?\n/).filter(Boolean);
	let branch = '';
	const dirty: string[] = [];
	for (const line of lines) {
		if (line.startsWith('##')) {
			const m = /^##\s+([^\s.]+)/.exec(line);
			branch = m?.[1] ?? '';
			continue;
		}
		const file = line.replace(/^..\s+/, '').trim();
		if (file) dirty.push(file.replace(/\\/g, '/'));
	}
	return { head: head.slice(0, 64), branch, dirty: dirty.slice(0, 12) };
}
