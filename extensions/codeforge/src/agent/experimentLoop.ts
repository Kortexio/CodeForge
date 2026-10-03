/**
 * Karpathy-style experiment loop: locked score paths, round log, method coach.
 * Pure path/lock helpers are unit-testable without vscode.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir } from '../storage/paths';

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
	return String(p ?? '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/+/g, '/')
		.replace(/^\//, '')
		.trim();
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

/** Paths a mutating tool would touch. */
export function pathsTouchedByTool(tool: string, args: Record<string, unknown>): string[] {
	switch (tool) {
		case 'write':
		case 'edit':
		case 'delete':
			return [normalizeRelPath(String(args.path ?? ''))].filter(Boolean);
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
		if (tool === 'shell' || tool === 'dotnet' || tool === 'delete' || tool === 'rename') {
			return `Not run: "${tool}" is not available in coach mode (only edit ${HOW_TO_WORK_REL}).`;
		}
		if (tool === 'write' || tool === 'edit') {
			const paths = pathsTouchedByTool(tool, args);
			if (!paths.length || paths.some(p => !isHowToWorkPath(p))) {
				return `Not run: coach mode may only write ${HOW_TO_WORK_REL}.`;
			}
		}
		return null;
	}

	if (opts.planMode) {
		if (tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'rename') {
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

	if (tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'rename') {
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

/** Coach runs when the latest feature had at least one undone round. */
export function shouldRunCoach(rounds: RoundResult[]): boolean {
	if (!rounds.length) return false;
	const latest = rounds[rounds.length - 1];
	const feature = latest.feature;
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
		`Read ${RESULTS_JSONL_REL} (summary below) and update only ${HOW_TO_WORK_REL}.`,
		'Add at most one short habit that prevents a repeating mistake (undone rounds or green checks with missing wiring).',
		'Do not edit code, tests, oracle.json, or checks.lock.',
		'If the skill file is missing, create it with YAML frontmatter name/description and a "## How to work" section.',
		'When done, reply with the habit you added (or say none).',
		'',
		'### Recent rounds',
		body || '(empty)',
	].join('\n');
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
