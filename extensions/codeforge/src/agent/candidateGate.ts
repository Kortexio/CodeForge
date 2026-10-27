/**
 * Single statistical gate for calibrate arms and harness revisions.
 * Stratified unpaired bootstrap + no-task regression. Ceiling tasks (both 100)
 * contribute 0 delta and never block.
 */

export const DEFAULT_MIN_REPS = 3;
export const DEFAULT_TASK_REGRESSION = 2;
export const DEFAULT_BOOTSTRAP_SAMPLES = 2000;

export type TaskSideScores = Record<string, { baseline: number[]; candidate: number[] }>;

export type CandidateDecision = {
	decision: 'keep' | 'revert';
	reason: string;
	baselineMean: number;
	candidateMean: number;
	lowerBound?: number;
};

export function meanScore(scores: number[]): number {
	if (!scores.length) return Number.NaN;
	return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function flatten(byTask: TaskSideScores, side: 'baseline' | 'candidate'): number[] {
	return Object.values(byTask).flatMap(p => p[side].filter(n => Number.isFinite(n)));
}

/** 90% one-sided lower bound on the mean of resampled values (10th percentile). */
export function bootstrapMeanLowerBound(
	values: number[],
	samples = DEFAULT_BOOTSTRAP_SAMPLES,
	quantile = 0.1,
	seed = 0xcf052026
): number {
	if (!values.length) return Number.NaN;
	const n = values.length;
	const means: number[] = [];
	let state = seed >>> 0;
	const rand = () => {
		state = (Math.imul(1664525, state) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	for (let b = 0; b < samples; b += 1) {
		let sum = 0;
		for (let i = 0; i < n; i += 1) {
			sum += values[Math.floor(rand() * n)]!;
		}
		means.push(sum / n);
	}
	means.sort((a, b) => a - b);
	const idx = Math.min(means.length - 1, Math.max(0, Math.floor(quantile * means.length)));
	return means[idx]!;
}

/**
 * Stratified unpaired bootstrap: for each task, resample baseline and candidate
 * with replacement, take mean difference, then average across tasks (ceiling
 * tasks contribute 0). Return the 10th percentile of those aggregated means.
 */
export function stratifiedBootstrapLowerBound(
	byTask: TaskSideScores,
	samples = DEFAULT_BOOTSTRAP_SAMPLES,
	seed = 0xcf0b0075
): number {
	const tasks = Object.keys(byTask);
	if (!tasks.length) return Number.NaN;
	let state = seed >>> 0;
	const rand = () => {
		state = (Math.imul(1664525, state) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const means: number[] = [];
	for (let b = 0; b < samples; b += 1) {
		let sum = 0;
		let weight = 0;
		for (const task of tasks) {
			const pair = byTask[task]!;
			const base = pair.baseline.filter(n => Number.isFinite(n));
			const cand = pair.candidate.filter(n => Number.isFinite(n));
			if (!base.length || !cand.length) continue;
			const baseMean = meanScore(base);
			const candMean = meanScore(cand);
			if (baseMean >= 100 && candMean >= 100) {
				sum += 0;
				weight += 1;
				continue;
			}
			let bSum = 0;
			let cSum = 0;
			for (let i = 0; i < base.length; i += 1) {
				bSum += base[Math.floor(rand() * base.length)]!;
			}
			for (let i = 0; i < cand.length; i += 1) {
				cSum += cand[Math.floor(rand() * cand.length)]!;
			}
			sum += cSum / cand.length - bSum / base.length;
			weight += 1;
		}
		if (weight > 0) means.push(sum / weight);
	}
	if (!means.length) return Number.NaN;
	means.sort((a, b) => a - b);
	const idx = Math.min(means.length - 1, Math.max(0, Math.floor(0.1 * means.length)));
	return means[idx]!;
}

export function decideCandidate(input: {
	byTask: TaskSideScores;
	minRepsPerTask?: number;
	taskRegressionMargin?: number;
	bootstrapSamples?: number;
}): CandidateDecision {
	const minReps = input.minRepsPerTask ?? DEFAULT_MIN_REPS;
	const margin = input.taskRegressionMargin ?? DEFAULT_TASK_REGRESSION;
	const samples = input.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
	const tasks = Object.keys(input.byTask);
	const baselineMean = meanScore(flatten(input.byTask, 'baseline'));
	const candidateMean = meanScore(flatten(input.byTask, 'candidate'));
	if (!tasks.length) {
		return {
			decision: 'revert',
			reason: 'no paired task scores',
			baselineMean: Number.NaN,
			candidateMean: Number.NaN,
		};
	}
	for (const task of tasks) {
		const pair = input.byTask[task]!;
		const baseline = pair.baseline.filter(n => Number.isFinite(n));
		const candidate = pair.candidate.filter(n => Number.isFinite(n));
		if (baseline.length < minReps || candidate.length < minReps) {
			return {
				decision: 'revert',
				reason: `${task}: need ${minReps} scores per side (baseline ${baseline.length}, candidate ${candidate.length})`,
				baselineMean,
				candidateMean,
			};
		}
		const bMean = meanScore(baseline);
		const cMean = meanScore(candidate);
		if (bMean >= 100 && cMean >= 100) continue;
		if (cMean < bMean - margin) {
			return {
				decision: 'revert',
				reason: `${task}: candidate mean ${cMean.toFixed(1)} is more than ${margin} below baseline ${bMean.toFixed(1)}`,
				baselineMean,
				candidateMean,
			};
		}
	}
	const lower = stratifiedBootstrapLowerBound(input.byTask, samples);
	if (!(lower > 0)) {
		return {
			decision: 'revert',
			reason: `stratified bootstrap 90% lower bound ${Number.isFinite(lower) ? lower.toFixed(2) : 'n/a'} is not > 0`,
			baselineMean,
			candidateMean,
			lowerBound: lower,
		};
	}
	return {
		decision: 'keep',
		reason: `all ${tasks.length} task(s) cleared stratified bootstrap with no regression beyond ${margin}`,
		baselineMean,
		candidateMean,
		lowerBound: lower,
	};
}

/** Ledger: expected labels must match recorded labels with no duplicates. */
export function assertLedger(input: {
	expected: string[];
	recorded: string[];
	unscored?: string[];
}): { ok: true } | { ok: false; reason: string } {
	const expected = input.expected.slice().sort();
	const recorded = input.recorded.slice().sort();
	const unscored = new Set(input.unscored ?? []);
	const dupes = recorded.filter((l, i) => recorded.indexOf(l) !== i);
	if (dupes.length) {
		return { ok: false, reason: `duplicate labels: ${[...new Set(dupes)].join(', ')}` };
	}
	if (unscored.size) {
		return {
			ok: false,
			reason: `unscored runs: ${[...unscored].join(', ')}`,
		};
	}
	if (expected.length !== recorded.length) {
		return {
			ok: false,
			reason: `count mismatch: expected ${expected.length}, recorded ${recorded.length}`,
		};
	}
	for (let i = 0; i < expected.length; i++) {
		if (expected[i] !== recorded[i]) {
			return {
				ok: false,
				reason: `label mismatch at ${i}: expected ${expected[i]}, got ${recorded[i]}`,
			};
		}
	}
	return { ok: true };
}
