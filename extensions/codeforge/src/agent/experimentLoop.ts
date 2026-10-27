/**
 * Karpathy-style experiment loop: locked score paths, round log, method coach.
 * Pure path/lock helpers are unit-testable without vscode.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir } from '../storage/paths';
import { FORBIDDEN_SNIPPETS } from './harnessRevision';

/** Pure copy of guardrailEngine.isTestFilePath — keeps this module free of vscode. */
function isTestFilePath(pathArg: unknown): boolean {
	const p = String(pathArg ?? '').replace(/\\/g, '/');
	return (
		/\/tests?\//i.test(p) ||
		/\.(tests?|spec)\.[^.]+$/i.test(p) ||
		/[\\/][^/]*Tests?[\\/]/i.test(p) ||
		/[\\/][^/]*Test\.[^/]+$/i.test(p)
	);
}

export const CHECKS_LOCK_REL = '.CodeForge/loop/checks.lock';
export const ORACLE_JSON_REL = '.CodeForge/oracle.json';
export const RESULTS_JSONL_REL = '.CodeForge/loop/results.jsonl';
export const HOW_TO_WORK_REL = '.CodeForge/skills/how-to-work/SKILL.md';
export const HABITS_REL = '.CodeForge/loop/habits.json';
export const MAX_ACTIVE_HABITS = 5;
export const HABIT_MAX_CHARS = 300;
export const HABIT_PROBATION_FEATURES = 3;

export interface ChecksLock {
	paths: string[];
	/** Feature task that produced this lock (optional metadata). */
	feature?: string;
	lockedAt?: string;
}

export interface RoundResult {
	kept: boolean;
	feature?: string;
	commands?: string[];
	failedTests?: string[];
	errors?: string[];
	files?: string[];
	at: string;
}

export function normalizeRelPath(p: string): string {
	const raw = String(p ?? '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/+/g, '/')
		.replace(/^\//, '')
		.trim();
	if (!raw) return '';
	const parts: string[] = [];
	for (const seg of raw.split('/')) {
		if (!seg || seg === '.') continue;
		if (seg === '..') {
			if (parts.length) parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join('/');
}

export function parseChecksLock(text: string): ChecksLock | undefined {
	try {
		const cfg = JSON.parse(text) as { paths?: unknown; feature?: unknown; lockedAt?: unknown };
		if (!Array.isArray(cfg.paths)) return undefined;
		const paths = cfg.paths.map(String).map(normalizeRelPath).filter(Boolean);
		if (!paths.length) return undefined;
		return {
			paths,
			...(typeof cfg.feature === 'string' && cfg.feature.trim()
				? { feature: cfg.feature.trim().slice(0, 200) }
				: {}),
			...(typeof cfg.lockedAt === 'string' && cfg.lockedAt.trim()
				? { lockedAt: cfg.lockedAt.trim() }
				: {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Paths written in plan that become the score for this feature.
 * Excludes the lock file and the results log themselves.
 */
export function isLockableCheckPath(relPath: string): boolean {
	const n = normalizeRelPath(relPath);
	if (!n) return false;
	const lower = n.toLowerCase();
	if (lower === normalizeRelPath(CHECKS_LOCK_REL).toLowerCase()) return false;
	if (lower === normalizeRelPath(RESULTS_JSONL_REL).toLowerCase()) return false;
	if (lower.startsWith('.codeforge/loop/')) return true;
	if (lower === normalizeRelPath(ORACLE_JSON_REL).toLowerCase()) return true;
	if (isTestFilePath(n)) return true;
	return false;
}

/** Deduped lockable paths from files written during a plan turn. */
export function collectLockablePaths(written: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of written) {
		const n = normalizeRelPath(raw);
		if (!n || !isLockableCheckPath(n)) continue;
		const key = n.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(n);
	}
	return out.sort((a, b) => a.localeCompare(b));
}

export function formatChecksLock(lock: ChecksLock): string {
	return JSON.stringify(
		{
			paths: lock.paths.map(normalizeRelPath).filter(Boolean),
			...(lock.feature ? { feature: lock.feature } : {}),
			...(lock.lockedAt ? { lockedAt: lock.lockedAt } : {}),
		},
		null,
		2
	) + '\n';
}

/** Write `.CodeForge/loop/checks.lock` for the current feature (auto-approve). */
export async function writeChecksLock(
	workspaceRoot: string | undefined,
	paths: string[],
	opts?: { feature?: string }
): Promise<ChecksLock | undefined> {
	if (!workspaceRoot) return undefined;
	const lockPaths = collectLockablePaths(paths);
	if (!lockPaths.length) return undefined;
	const lock: ChecksLock = {
		paths: lockPaths,
		...(opts?.feature ? { feature: opts.feature.slice(0, 200) } : {}),
		lockedAt: new Date().toISOString(),
	};
	const file = path.join(workspaceRoot, CHECKS_LOCK_REL);
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, formatChecksLock(lock), 'utf8');
	return lock;
}

/** Always-locked score files plus paths listed in the lock. */
export function lockedScorePaths(lock: ChecksLock): string[] {
	const set = new Set<string>([
		normalizeRelPath(CHECKS_LOCK_REL),
		normalizeRelPath(ORACLE_JSON_REL),
		...lock.paths.map(normalizeRelPath),
	]);
	return [...set];
}

export function isLockedScorePath(relPath: string, locked: string[]): boolean {
	const n = normalizeRelPath(relPath).toLowerCase();
	if (!n) return false;
	return locked.some(p => normalizeRelPath(p).toLowerCase() === n);
}

/** Paths mentioned in apply_patch body (*** Update/Add/Delete File: …). */
function pathsFromPatchText(patch: string): string[] {
	const out: string[] = [];
	const re = /^\*\*\*\s+(?:Update|Add|Delete|Move)\s+File:\s*(.+)$/gim;
	let m: RegExpExecArray | null;
	while ((m = re.exec(String(patch || ''))) !== null) {
		const p = normalizeRelPath(m[1].trim());
		if (p) out.push(p);
	}
	return out;
}

/** Paths a mutating tool would touch. */
export function pathsTouchedByTool(tool: string, args: Record<string, unknown>): string[] {
	switch (tool) {
		case 'write':
		case 'edit':
		case 'delete':
			return [normalizeRelPath(String(args.path ?? ''))].filter(Boolean);
		case 'apply_patch': {
			const fromArg = normalizeRelPath(String(args.path ?? ''));
			const fromBody = pathsFromPatchText(String(args.patch ?? args.patchText ?? args.patch_text ?? ''));
			const seen = new Set<string>();
			const out: string[] = [];
			for (const p of [fromArg, ...fromBody]) {
				if (!p) continue;
				const key = p.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(p);
			}
			return out;
		}
		case 'rename': {
			const oldP = normalizeRelPath(String(args.oldPath ?? args.path ?? ''));
			const newP = normalizeRelPath(String(args.newPath ?? args.to ?? ''));
			return [oldP, newP].filter(Boolean);
		}
		default:
			return [];
	}
}

/** True when a shell command mentions a locked relative path (slash or backslash). */
export function shellMentionsLockedPath(command: string, locked: string[]): boolean {
	const cmd = String(command ?? '');
	if (!cmd.trim() || !locked.length) return false;
	const lower = cmd.toLowerCase().replace(/\\/g, '/');
	return locked.some(p => {
		const n = normalizeRelPath(p).toLowerCase();
		if (!n) return false;
		if (lower.includes(n)) return true;
		const base = n.split('/').pop() ?? '';
		// Only match basename when it is distinctive (lock/oracle/skill names).
		if (base === 'checks.lock' || base === 'oracle.json' || base === 'skill.md') {
			return lower.includes(base);
		}
		return false;
	});
}

export function isHowToWorkPath(relPath: string): boolean {
	return normalizeRelPath(relPath).toLowerCase() === normalizeRelPath(HOW_TO_WORK_REL).toLowerCase();
}

/** Plan may draft checks / lock / oracle before and after approval. */
export function planMayWritePath(relPath: string, locked: string[]): boolean {
	const n = normalizeRelPath(relPath);
	if (!n) return false;
	const lower = n.toLowerCase();
	if (lower.startsWith('.codeforge/loop/')) return true;
	if (lower === normalizeRelPath(ORACLE_JSON_REL).toLowerCase()) return true;
	if (isLockedScorePath(n, locked)) return true;
	if (isTestFilePath(n)) return true;
	return false;
}

/**
 * Deny message when build tries to edit the score, or coach leaves how-to-work,
 * or plan writes outside the check surface.
 */
export function denyExperimentMutation(
	tool: string,
	args: Record<string, unknown>,
	opts: {
		experimentActive: boolean;
		planMode?: boolean;
		coachMode?: boolean;
		locked: string[];
	}
): string | null {
	if (opts.coachMode) {
		if (
			tool === 'shell' ||
			tool === 'dotnet' ||
			tool === 'delete' ||
			tool === 'rename' ||
			tool === 'write' ||
			tool === 'edit' ||
			tool === 'apply_patch'
		) {
			return `Not run: coach mode is JSON-only (habits are written by the harness).`;
		}
		return null;
	}

	if (opts.planMode) {
		if (tool === 'write' || tool === 'edit' || tool === 'apply_patch' || tool === 'delete' || tool === 'rename') {
			const paths = pathsTouchedByTool(tool, args);
			if (!paths.length || paths.some(p => !planMayWritePath(p, opts.locked))) {
				return `Not run: in Plan mode write only checks, ${CHECKS_LOCK_REL}, or ${ORACLE_JSON_REL}.`;
			}
		}
		return null;
	}

	if (!opts.experimentActive || !opts.locked.length) return null;

	if (tool === 'shell') {
		if (shellMentionsLockedPath(String(args.command ?? ''), opts.locked)) {
			return `Not run: shell must not touch locked score paths (${opts.locked.slice(0, 4).join(', ')}).`;
		}
		return null;
	}

	if (tool === 'write' || tool === 'edit' || tool === 'apply_patch' || tool === 'delete' || tool === 'rename') {
		const paths = pathsTouchedByTool(tool, args);
		const hit = paths.find(p => isLockedScorePath(p, opts.locked));
		if (hit) {
			return `Not run: "${hit}" is a locked score path (experiment loop).`;
		}
	}
	return null;
}

export function formatRoundResultLine(r: RoundResult): string {
	return JSON.stringify({
		kept: r.kept,
		...(r.feature ? { feature: r.feature } : {}),
		...(r.commands?.length ? { commands: r.commands } : {}),
		...(r.failedTests?.length ? { failedTests: r.failedTests } : {}),
		...(r.errors?.length ? { errors: r.errors } : {}),
		...(r.files?.length ? { files: r.files } : {}),
		at: r.at,
	});
}

export function parseRoundResults(text: string): RoundResult[] {
	const out: RoundResult[] = [];
	for (const line of String(text || '').split(/\r?\n/)) {
		const t = line.trim();
		if (!t) continue;
		try {
			const row = JSON.parse(t) as RoundResult;
			if (typeof row.kept === 'boolean' && typeof row.at === 'string') {
				out.push(row);
			}
		} catch {
			/* skip */
		}
	}
	return out;
}

export type HabitStatus = 'probation' | 'kept' | 'removed';

export type Habit = {
	id: string;
	cue: string;
	habit: string;
	evidence: string[];
	confidence: string;
	status: HabitStatus;
	featureKey: string;
	baselineUndoRate: number;
	featuresSeen: number;
	at: string;
};

export type HabitsFile = { version: 1; habits: Habit[]; coachedFeatures: string[] };

export function emptyHabitsFile(): HabitsFile {
	return { version: 1, habits: [], coachedFeatures: [] };
}

export function parseHabitsFile(text: string): HabitsFile {
	try {
		const raw = JSON.parse(text) as Partial<HabitsFile>;
		return {
			version: 1,
			habits: Array.isArray(raw.habits) ? (raw.habits as Habit[]) : [],
			coachedFeatures: Array.isArray(raw.coachedFeatures)
				? raw.coachedFeatures.map(String)
				: [],
		};
	} catch {
		return emptyHabitsFile();
	}
}

export function featureKeyFromLock(lock: ChecksLock): string {
	return `${lock.feature || 'feature'}@${lock.lockedAt || 'unknown'}`;
}

export function undoRate(rounds: RoundResult[], feature?: string): number {
	const rows = feature
		? rounds.filter(r => !feature || r.feature === feature)
		: rounds;
	if (!rows.length) return 0;
	const undone = rows.filter(r => r.kept === false).length;
	return undone / rows.length;
}

/** Coach runs at most once per feature key, and only when that feature had an undone round. */
export function shouldRunCoach(
	rounds: RoundResult[],
	opts?: { featureKey?: string; coachedFeatures?: string[] }
): boolean {
	if (!rounds.length) return false;
	const latest = rounds[rounds.length - 1];
	const feature = latest.feature;
	const key = opts?.featureKey || feature || '';
	if (key && opts?.coachedFeatures?.includes(key)) return false;
	const forFeature: RoundResult[] = [];
	for (let i = rounds.length - 1; i >= 0; i--) {
		const row = rounds[i];
		if (feature && row.feature && row.feature !== feature) break;
		forFeature.unshift(row);
	}
	return forFeature.some(r => r.kept === false);
}

export function coachTaskPrompt(rounds: RoundResult[], feature: string): string {
	const recent = rounds.slice(-12);
	const body = recent.map(formatRoundResultLine).join('\n');
	return [
		'You are the experiment-loop method coach.',
		`Feature just finished: ${feature}`,
		'Reply with one JSON object only. No tools, no markdown fences.',
		'Schema: {"rounds":[{"id":"r1","change":"...","observed":"...","verdict":"helped|hurt|no observed effect|confounded"}],"habit":{"cue":"...","habit":"...","evidence":["r1"],"confidence":"medium"} }',
		'Or {"rounds":[...],"habit":"NO_ENTRY"} when nothing transfers.',
		'A habit resting only on confounded rounds is invalid — use NO_ENTRY.',
		`Habit text is at most ${HABIT_MAX_CHARS} characters. Cue is the situation shape, not this feature's facts.`,
		'Do not edit code, tests, oracle.json, or checks.lock.',
		'',
		'### Recent rounds',
		body || '(empty)',
	].join('\n');
}

export function parseCoachHabit(
	raw: string
):
	| { ok: true; habit: Omit<Habit, 'id' | 'status' | 'featureKey' | 'baselineUndoRate' | 'featuresSeen' | 'at'> | null }
	| { ok: false; error: string } {
	const text = String(raw ?? '')
		.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
		.replace(/```(?:json)?/gi, '');
	let obj: Record<string, unknown> | undefined;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '{') continue;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let j = i; j < text.length; j++) {
			const c = text[j];
			if (inStr) {
				if (esc) {
					esc = false;
					continue;
				}
				if (c === '\\') {
					esc = true;
					continue;
				}
				if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') {
				inStr = true;
				continue;
			}
			if (c === '{') depth += 1;
			else if (c === '}') {
				depth -= 1;
				if (depth === 0) {
					try {
						obj = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
					} catch {
						obj = undefined;
					}
					break;
				}
			}
		}
		if (obj) break;
	}
	if (!obj) return { ok: false, error: 'no JSON object' };
	const rounds = Array.isArray(obj.rounds) ? obj.rounds : [];
	const confoundedOnly =
		rounds.length > 0 &&
		rounds.every(
			r =>
				r &&
				typeof r === 'object' &&
				String((r as Record<string, unknown>).verdict || '').toLowerCase() === 'confounded'
		);
	if (obj.habit === 'NO_ENTRY' || obj.habit === null) {
		return { ok: true, habit: null };
	}
	if (confoundedOnly) return { ok: false, error: 'habit rests only on confounded rounds' };
	const h = obj.habit;
	if (!h || typeof h !== 'object' || Array.isArray(h)) {
		return { ok: false, error: 'habit missing' };
	}
	const habit = String((h as Record<string, unknown>).habit ?? '').trim();
	const cue = String((h as Record<string, unknown>).cue ?? '').trim();
	const confidence = String((h as Record<string, unknown>).confidence ?? 'medium').trim();
	const evidence = Array.isArray((h as Record<string, unknown>).evidence)
		? ((h as Record<string, unknown>).evidence as unknown[]).map(String)
		: [];
	if (!habit || !cue) return { ok: false, error: 'cue and habit required' };
	if (habit.length > HABIT_MAX_CHARS) return { ok: false, error: 'habit too long' };
	const lower = `${cue} ${habit}`.toLowerCase();
	const banned = FORBIDDEN_SNIPPETS.find(s => lower.includes(s));
	if (banned) return { ok: false, error: `forbidden text (${banned})` };
	return {
		ok: true,
		habit: { cue, habit, evidence, confidence },
	};
}

export function habitIsDuplicate(file: HabitsFile, cue: string, habit: string): boolean {
	const cueKey = cue.trim().toLowerCase();
	const habitKey = habit.trim().toLowerCase();
	return file.habits.some(
		h =>
			(h.status === 'probation' || h.status === 'kept') &&
			h.cue.trim().toLowerCase() === cueKey &&
			h.habit.trim().toLowerCase() === habitKey
	);
}

export function addHabitOnProbation(
	file: HabitsFile,
	draft: Omit<Habit, 'id' | 'status' | 'featureKey' | 'baselineUndoRate' | 'featuresSeen' | 'at'>,
	opts: { featureKey: string; baselineUndoRate: number; at?: string }
): HabitsFile | { error: string } {
	if (habitIsDuplicate(file, draft.cue, draft.habit)) {
		return { error: 'duplicate habit' };
	}
	const id = `h${file.habits.length + 1}-${Date.now().toString(36)}`;
	const next: Habit = {
		...draft,
		id,
		status: 'probation',
		featureKey: opts.featureKey,
		baselineUndoRate: opts.baselineUndoRate,
		featuresSeen: 0,
		at: opts.at || new Date().toISOString(),
	};
	const habits = [...file.habits, next];
	const active = habits.filter(h => h.status === 'probation' || h.status === 'kept');
	if (active.length > MAX_ACTIVE_HABITS) {
		const drop = active.find(h => h.status === 'probation' && h.id !== next.id) || active[0];
		return {
			...file,
			habits: habits.map(h =>
				h.id === drop.id ? { ...h, status: 'removed' as const } : h
			),
		};
	}
	return { ...file, habits };
}

export async function readHabitsFile(workspaceRoot: string | undefined): Promise<HabitsFile> {
	if (!workspaceRoot) return emptyHabitsFile();
	try {
		const text = await fs.readFile(path.join(workspaceRoot, HABITS_REL), 'utf8');
		return parseHabitsFile(text);
	} catch {
		return emptyHabitsFile();
	}
}

export async function writeHabitsAndSkill(
	workspaceRoot: string | undefined,
	file: HabitsFile
): Promise<void> {
	if (!workspaceRoot) return;
	const habitsPath = path.join(workspaceRoot, HABITS_REL);
	const skillPath = path.join(workspaceRoot, HOW_TO_WORK_REL);
	await ensureDir(path.dirname(habitsPath));
	await ensureDir(path.dirname(skillPath));
	await fs.writeFile(habitsPath, JSON.stringify(file, null, 2), 'utf8');
	await fs.writeFile(skillPath, renderHowToWork(file.habits), 'utf8');
}

/** Apply coach JSON: validate habit, advance probation, persist habits + SKILL.md. */
export async function applyCoachReply(
	workspaceRoot: string | undefined,
	raw: string,
	rounds: RoundResult[],
	lock: ChecksLock | undefined
): Promise<{ summary: string; file: HabitsFile }> {
	const featureKey = lock ? featureKeyFromLock(lock) : `feature@${Date.now()}`;
	let file = await readHabitsFile(workspaceRoot);
	// Advance existing probation habits for this feature before adding a new one.
	file = advanceHabitProbation(file, rounds, featureKey);
	const parsed = parseCoachHabit(raw);
	const baseline = undoRate(rounds);
	if (!parsed.ok) {
		await writeHabitsAndSkill(workspaceRoot, file);
		return { summary: `Coach JSON invalid: ${parsed.error}`, file };
	}
	if (parsed.habit) {
		const added = addHabitOnProbation(file, parsed.habit, {
			featureKey,
			baselineUndoRate: baseline,
		});
		if ('error' in added) {
			await writeHabitsAndSkill(workspaceRoot, file);
			return { summary: `Habit rejected: ${added.error}`, file };
		}
		file = added;
	}
	await writeHabitsAndSkill(workspaceRoot, file);
	const active = file.habits.filter(h => h.status === 'probation' || h.status === 'kept');
	const summary = parsed.habit
		? `Added habit on probation (${active.length} active).`
		: `No habit entry (${active.length} active).`;
	return { summary, file };
}

export function renderHowToWork(habits: Habit[]): string {
	const active = habits
		.filter(h => h.status === 'probation' || h.status === 'kept')
		.slice(0, MAX_ACTIVE_HABITS);
	const lines = [
		'---',
		'name: how-to-work',
		'description: Habits kept from the experiment loop.',
		'---',
		'',
		'## How to work',
		'',
	];
	if (!active.length) {
		lines.push('_No habits kept yet._', '');
	} else {
		for (const h of active) {
			lines.push(`- (${h.status}) When ${h.cue}: ${h.habit}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

export function advanceHabitProbation(
	file: HabitsFile,
	rounds: RoundResult[],
	featureKey: string
): HabitsFile {
	const rate = undoRate(rounds);
	const habits = file.habits.map(h => {
		if (h.status !== 'probation') return h;
		const next = { ...h, featuresSeen: h.featuresSeen + 1 };
		if (next.featuresSeen < HABIT_PROBATION_FEATURES) return next;
		if (rate < h.baselineUndoRate) {
			return { ...next, status: 'kept' as const };
		}
		return { ...next, status: 'removed' as const };
	});
	return {
		...file,
		habits,
		coachedFeatures: [...new Set([...file.coachedFeatures, featureKey])].slice(-40),
	};
}

export function experimentSystemHint(): string {
	return [
		'### Experiment loop (active)',
		`Score is locked via ${CHECKS_LOCK_REL}. Do not edit locked check paths, ${ORACLE_JSON_REL}, or the lock file.`,
		`Call skill \`how-to-work\` before the first write so habits from prior features apply.`,
		'One coherent attempt per round; the harness reverts the turn when the oracle is red.',
	].join('\n');
}

export async function readChecksLock(workspaceRoot: string | undefined): Promise<ChecksLock | undefined> {
	if (!workspaceRoot) return undefined;
	try {
		const text = await fs.readFile(path.join(workspaceRoot, CHECKS_LOCK_REL), 'utf8');
		return parseChecksLock(text);
	} catch {
		return undefined;
	}
}

export async function experimentActive(workspaceRoot: string | undefined): Promise<boolean> {
	const lock = await readChecksLock(workspaceRoot);
	return !!lock;
}

export async function appendRoundResult(
	workspaceRoot: string | undefined,
	result: RoundResult
): Promise<void> {
	if (!workspaceRoot) return;
	const file = path.join(workspaceRoot, RESULTS_JSONL_REL);
	await ensureDir(path.dirname(file));
	await fs.appendFile(file, formatRoundResultLine(result) + '\n', 'utf8');
}

export async function readRoundResults(workspaceRoot: string | undefined): Promise<RoundResult[]> {
	if (!workspaceRoot) return [];
	try {
		const text = await fs.readFile(path.join(workspaceRoot, RESULTS_JSONL_REL), 'utf8');
		return parseRoundResults(text);
	} catch {
		return [];
	}
}
