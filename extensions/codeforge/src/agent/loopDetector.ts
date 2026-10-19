/**
 * Detects tool-loop stalls from identical call+result streaks (and related counters).
 * Pure — no vscode.
 */

export interface LoopDetector {
	recordCall(fingerprint: string, resultHash: string): { note?: string };
	endStep(): void;
	shouldStop(): boolean;
	cause(): string;
	setExploreOnlySteps(n: number): void;
	getExploreOnlySteps(): number;
	setUnchangedStreak(n: number): void;
	getUnchangedStreak(): number;
	/** Consecutive steps where every call repeated a prior fingerprint+result. */
	getConsecutiveIdenticalSteps(): number;
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

export function createLoopDetector(): LoopDetector {
	let currentStep = 1;
	let consecutiveIdenticalSteps = 0;
	let exploreOnlySteps = 0;
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
			return consecutiveIdenticalSteps >= 3 || exploreOnlySteps >= 20 || unchangedStreak >= 3;
		},

		cause(): string {
			if (consecutiveIdenticalSteps >= 3) {
				return 'identical tool calls and results for 3 consecutive steps';
			}
			if (unchangedStreak >= 3) {
				return 'browser UI UNCHANGED for 3 consecutive actions';
			}
			if (exploreOnlySteps >= 20) {
				return '20 consecutive explore-only steps without a write or shell';
			}
			return 'tools stuck without progress';
		},

		setExploreOnlySteps(n: number): void {
			exploreOnlySteps = Math.max(0, n);
		},

		getExploreOnlySteps(): number {
			return exploreOnlySteps;
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
	};
}
