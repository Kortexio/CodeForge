/**
 * Structural finish gate: exploration-only runs cannot close as "done"
 * (weak models otherwise stop at a bug list). Not intent sniffing on user text.
 */

/** Tools that change the workspace, run commands, or act on the browser UI. */
export const EFFECTFUL_TOOLS = new Set([
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
]);

export function isEffectfulTool(name: string): boolean {
	return EFFECTFUL_TOOLS.has(name);
}

export type DiagFinishGateInput = {
	planMode?: boolean;
	askMode?: boolean;
	reviewMode?: boolean;
	coachMode?: boolean;
	statusQuestion?: boolean;
	/** Model claimed blocked: <reason>. */
	blocked?: boolean;
	/** Successful effectful tools this runAgentWithTools invocation. */
	effectfulCount: number;
	/** Any tool executed this run (including explore-only). */
	anyToolCount: number;
	/** How many times we already refused diagnose-only finish this run. */
	diagFinishNudges: number;
	/** Max refuses before accepting prose finish. */
	maxDiagFinishNudges?: number;
};

/**
 * True when the harness should refuse prose finish and demand an effectful tool
 * (or blocked:) instead of accepting a diagnosis-only wrap-up.
 */
export function shouldRefuseDiagFinish(input: DiagFinishGateInput): boolean {
	if (input.planMode || input.askMode || input.reviewMode || input.coachMode || input.statusQuestion) {
		return false;
	}
	if (input.blocked) return false;
	if (input.effectfulCount > 0) return false;
	if (input.anyToolCount < 1) return false;
	const max = input.maxDiagFinishNudges ?? 2;
	if (input.diagFinishNudges >= max) return false;
	return true;
}

export type SpecSelfCheckInput = {
	planMode?: boolean;
	askMode?: boolean;
	reviewMode?: boolean;
	coachMode?: boolean;
	statusQuestion?: boolean;
	blocked?: boolean;
	/** Build/test verified green this run (oracle or test command). */
	verifiedGreen: boolean;
	/** Production source files written/edited. */
	writtenSourceCount: number;
	/** Spec/docs paths read this run. */
	readSpecCount: number;
	/** Test files written/edited. */
	writtenTestCount: number;
	/** How many times this one-shot already fired. */
	specCheckNudges: number;
};

/**
 * One-shot structural reminder after production edits when a spec was read
 * or no tests were touched. Path/oracle state only — not reply-text sniffing.
 */
export function shouldRequestSpecSelfCheck(input: SpecSelfCheckInput): boolean {
	if (input.planMode || input.askMode || input.reviewMode || input.coachMode || input.statusQuestion) {
		return false;
	}
	if (input.blocked) return false;
	if (!input.verifiedGreen) return false;
	if (input.specCheckNudges >= 1) return false;
	if (input.writtenSourceCount < 1) return false;
	// Require a read spec AND no test-file edits — avoids speculative "fixes" on scaffold/card runs
	// that never touched docs, while still catching T2-style "src only after reading docs".
	return input.readSpecCount > 0 && input.writtenTestCount === 0;
}
