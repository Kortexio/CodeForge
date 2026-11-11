/**
 * Detects tool-loop stalls from identical call+result streaks (and related counters).
 * Pure — no vscode.
 *
 * No explore-step soft/hard caps: like Cursor/Claude Code, reads are unlimited within the
 * turn step budget. Stall = identical repeats, the same explore family (list folder,
 * search needle, re-read path, web query, workspace diagnostics), or browser UI unchanged.
 */

/** Folder a list call belongs to: the path itself, or the parent when the list failed. */
export function listFamilyKey(raw: string, failed: boolean): string {
	const p = String(raw || '')
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/$/, '')
		.toLowerCase();
	const parts = p.split('/').filter(s => s && s !== '.');
	if (parts.length === 0) return 'list:.';
	if (failed && parts.length > 1) return `list:${parts.slice(0, -1).join('/')}`;
	return `list:${parts.join('/')}`;
}

/** Scope + alphanumeric tokens ≥4 from a search pattern (launch / launch.json / \\blaunch). */
export function searchFamilyKey(pattern: string, scopePath?: string): string {
	const scope = String(scopePath || '.')
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/$/, '')
		.toLowerCase() || '.';
	// Drop regex anchors and common extensions so launch.json / \blaunch share a family with launch.
	const cleaned = String(pattern || '')
		.toLowerCase()
		.replace(/\\[bBwWdDsS]/g, '')
		.replace(/\.(json|ts|tsx|js|jsx|mjs|cjs|cs|md|xml|yml|yaml|txt|html|css|scss)\b/g, '');
	const tokens = (cleaned.match(/[a-z0-9]{4,}/g) || []).filter(Boolean);
	const uniq = [...new Set(tokens)].sort();
	const needle = uniq.length ? uniq.join('+') : cleaned.replace(/[^a-z0-9]+/g, '').slice(0, 24);
	return `search:${scope}|${needle}`;
}

/** Same-path re-read family (overlapping / unchanged windows are decided by the caller). */
export function readFamilyKey(rawPath: string): string {
	const p = String(rawPath || '')
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/$/, '')
		.toLowerCase();
	return `read:${p || '.'}`;
}

/** Zero-hit web_search family from the query string. */
export function webSearchFamilyKey(query: string): string {
	const tokens = (String(query || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(Boolean);
	const uniq = [...new Set(tokens)].sort();
	const needle = uniq.length ? uniq.join('+') : String(query || '').toLowerCase().slice(0, 24);
	return `web:${needle}`;
}

/** Workspace-wide diagnostics (path-scoped calls do not use this). */
export const DIAGNOSTICS_WORKSPACE_FAMILY = 'diagnostics:workspace';

/** Same-pattern glob family (scope + exact pattern). */
export function globFamilyKey(pattern: string, scopePath?: string): string {
	const scope = String(scopePath || '.')
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/$/, '')
		.toLowerCase() || '.';
	const pat = String(pattern || '')
		.replace(/\\/g, '/')
		.toLowerCase()
		.trim();
	return `glob:${scope}|${pat}`;
}

export const EXPLORE_TOOL_NAMES = [
	'read',
	'list',
	'glob',
	'search',
	'retrieve',
	'symbols',
	'definition',
	'references',
] as const;

export function isExploreToolName(name: string): boolean {
	return (EXPLORE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Tools that count as real progress for write/oracle gates elsewhere.
 * skill / update_status / await_shell alone must NOT reset progress streaks.
 */
export const EFFECTFUL_TOOL_NAMES = [
	'edit',
	'write',
	'apply_patch',
	'delete',
	'rename',
	'shell',
	'dotnet',
	'browser_navigate',
	'browser_click',
	'browser_type',
	'browser_snapshot',
	'browser_screenshot',
] as const;

export function isEffectfulToolName(name: string): boolean {
	return (EFFECTFUL_TOOL_NAMES as readonly string[]).includes(name);
}

export type StallKind =
	| 'identical'
	| 'unchanged'
	| 'list-family'
	| 'search-family'
	| 'glob-family'
	| 'read-family'
	| 'web-search-family'
	| 'diagnostics-family';

function stallKindFromFamily(family: string): StallKind | null {
	if (family.startsWith('list:')) return 'list-family';
	if (family.startsWith('search:')) return 'search-family';
	if (family.startsWith('glob:')) return 'glob-family';
	if (family.startsWith('read:')) return 'read-family';
	if (family.startsWith('web:')) return 'web-search-family';
	if (family.startsWith('diagnostics:')) return 'diagnostics-family';
	return null;
}

export interface LoopDetector {
	recordCall(
		fingerprint: string,
		resultHash: string,
		meta?: { listFamily?: string; family?: string }
	): { note?: string };
	endStep(): void;
	shouldStop(): boolean;
	cause(): string;
	setUnchangedStreak(n: number): void;
	getUnchangedStreak(): number;
	/** Consecutive steps where every call repeated a prior fingerprint+result. */
	getConsecutiveIdenticalSteps(): number;
	/** Consecutive explore-family-only steps on the same family key. */
	getConsecutiveListFamilySteps(): number;
	/** Which stall is active, if shouldStop() is true. */
	stallKind(): StallKind | null;
	/** Clear identical + explore-family streaks so one recovery round can run. */
	resetIdenticalStreak(): void;
}

/** Simple stable hash of tool result text (for identity, not security). */
export function hashResult(text: string): string {
	let h = 2166136261;
	const s = String(text ?? '');
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

function normalizeFamilyMeta(meta?: { listFamily?: string; family?: string }): string | undefined {
	const raw = meta?.family?.trim() || meta?.listFamily?.trim() || '';
	if (!raw) return undefined;
	// Legacy callers passed bare list paths; prefix them.
	if (
		!raw.startsWith('list:') &&
		!raw.startsWith('search:') &&
		!raw.startsWith('glob:') &&
		!raw.startsWith('read:') &&
		!raw.startsWith('web:') &&
		!raw.startsWith('diagnostics:')
	) {
		return `list:${raw}`;
	}
	return raw;
}

export function createLoopDetector(opts?: { stallThreshold?: number }): LoopDetector {
	const stallThreshold = Math.max(2, Math.floor(opts?.stallThreshold ?? 3));
	let currentStep = 1;
	let consecutiveIdenticalSteps = 0;
	let consecutiveListFamilySteps = 0;
	let lastListFamily = '';
	let unchangedStreak = 0;
	/** fingerprint\0resultHash → step number when first seen */
	const firstSeen = new Map<string, number>();
	let stepCalls: Array<{ isRepeat: boolean; listFamily?: string }> = [];

	return {
		recordCall(
			fingerprint: string,
			resultHash: string,
			meta?: { listFamily?: string; family?: string }
		): { note?: string } {
			const key = `${fingerprint}\0${resultHash}`;
			const prior = firstSeen.get(key);
			const listFamily = normalizeFamilyMeta(meta);
			if (prior !== undefined) {
				stepCalls.push({ isRepeat: true, listFamily });
				return { note: `(identical call and result to step ${prior})` };
			}
			firstSeen.set(key, currentStep);
			stepCalls.push({ isRepeat: false, listFamily });
			return {};
		},

		endStep(): void {
			if (stepCalls.length > 0 && stepCalls.every(c => c.isRepeat)) {
				consecutiveIdenticalSteps += 1;
			} else {
				consecutiveIdenticalSteps = 0;
			}
			const families = stepCalls.map(c => c.listFamily).filter((f): f is string => Boolean(f));
			if (
				stepCalls.length > 0 &&
				families.length === stepCalls.length &&
				new Set(families).size === 1
			) {
				const family = families[0];
				if (family === lastListFamily) consecutiveListFamilySteps += 1;
				else {
					lastListFamily = family;
					consecutiveListFamilySteps = 1;
				}
			} else {
				consecutiveListFamilySteps = 0;
				lastListFamily = '';
			}
			stepCalls = [];
			currentStep += 1;
		},

		shouldStop(): boolean {
			return (
				consecutiveIdenticalSteps >= stallThreshold ||
				consecutiveListFamilySteps >= stallThreshold ||
				unchangedStreak >= 3
			);
		},

		cause(): string {
			if (consecutiveIdenticalSteps >= stallThreshold) {
				return `identical tool calls and results for ${stallThreshold} consecutive steps`;
			}
			if (consecutiveListFamilySteps >= stallThreshold) {
				const kind = stallKindFromFamily(lastListFamily);
				if (kind === 'search-family') {
					return `search of the same needle/scope for ${stallThreshold} consecutive steps`;
				}
				if (kind === 'glob-family') {
					return `glob of the same pattern/scope for ${stallThreshold} consecutive steps`;
				}
				if (kind === 'read-family') {
					return `re-read of the same file for ${stallThreshold} consecutive steps`;
				}
				if (kind === 'web-search-family') {
					return `web_search of the same query for ${stallThreshold} consecutive steps`;
				}
				if (kind === 'diagnostics-family') {
					return `workspace diagnostics repeated for ${stallThreshold} consecutive steps`;
				}
				return `list of the same folder (or its missing children) for ${stallThreshold} consecutive steps`;
			}
			if (unchangedStreak >= 3) {
				return 'browser UI UNCHANGED for 3 consecutive actions';
			}
			return 'tools stuck without progress';
		},

		setUnchangedStreak(n: number): void {
			unchangedStreak = Math.max(0, n);
		},

		getUnchangedStreak(): number {
			return unchangedStreak;
		},

		getConsecutiveIdenticalSteps(): number {
			return consecutiveIdenticalSteps;
		},

		getConsecutiveListFamilySteps(): number {
			return consecutiveListFamilySteps;
		},

		stallKind(): StallKind | null {
			if (consecutiveIdenticalSteps >= stallThreshold) return 'identical';
			if (consecutiveListFamilySteps >= stallThreshold) {
				return stallKindFromFamily(lastListFamily) ?? 'list-family';
			}
			if (unchangedStreak >= 3) return 'unchanged';
			return null;
		},

		resetIdenticalStreak(): void {
			consecutiveIdenticalSteps = 0;
			consecutiveListFamilySteps = 0;
			lastListFamily = '';
			stepCalls = [];
		},
	};
}
