/**
 * Detects tool-loop stalls from identical call+result streaks (and related counters).
 * Pure — no vscode.
 *
 * No explore-step soft/hard caps: like Cursor/Claude Code, reads are unlimited within the
 * turn step budget. Stall = identical repeats or browser UI unchanged.
 */

export const EXPLORE_TOOL_NAMES = [
	'read',
	'list',
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

export interface LoopDetector {
	recordCall(fingerprint: string, resultHash: string): { note?: string };
	endStep(): void;
	shouldStop(): boolean;
	cause(): string;
	setUnchangedStreak(n: number): void;
	getUnchangedStreak(): number;
	/** Consecutive steps where every call repeated a prior fingerprint+result. */
	getConsecutiveIdenticalSteps(): number;
	/** Which stall is active, if shouldStop() is true. */
	stallKind(): 'identical' | 'unchanged' | null;
	/** Clear the identical-call streak so one recovery round can run. */
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

export function createLoopDetector(opts?: { stallThreshold?: number }): LoopDetector {
	const stallThreshold = Math.max(2, Math.floor(opts?.stallThreshold ?? 3));
	let currentStep = 1;
	let consecutiveIdenticalSteps = 0;
	let unchangedStreak = 0;
	/** fingerprint\0resultHash → step number when first seen */
	const firstSeen = new Map<string, number>();
	let stepCalls: Array<{ isRepeat: boolean }> = [];

	return {
		recordCall(fingerprint: string, resultHash: string): { note?: string } {
			const key = `${fingerprint}\0${resultHash}`;
			const prior = firstSeen.get(key);
			if (prior !== undefined) {
				stepCalls.push({ isRepeat: true });
				return { note: `(identical call and result to step ${prior})` };
			}
			firstSeen.set(key, currentStep);
			stepCalls.push({ isRepeat: false });
			return {};
		},

		endStep(): void {
			if (stepCalls.length > 0 && stepCalls.every(c => c.isRepeat)) {
				consecutiveIdenticalSteps += 1;
			} else {
				consecutiveIdenticalSteps = 0;
			}
			stepCalls = [];
			currentStep += 1;
		},

		shouldStop(): boolean {
			return consecutiveIdenticalSteps >= stallThreshold || unchangedStreak >= 3;
		},

		cause(): string {
			if (consecutiveIdenticalSteps >= stallThreshold) {
				return `identical tool calls and results for ${stallThreshold} consecutive steps`;
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

		stallKind(): 'identical' | 'unchanged' | null {
			if (consecutiveIdenticalSteps >= stallThreshold) return 'identical';
			if (unchangedStreak >= 3) return 'unchanged';
			return null;
		},

		resetIdenticalStreak(): void {
			consecutiveIdenticalSteps = 0;
			stepCalls = [];
		},
	};
}
