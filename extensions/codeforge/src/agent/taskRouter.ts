/**
 * Picks the run shape for a user turn: bug-hunt pipeline, card orchestration, or a single loop.
 * Shared by the chat view and the headless benchmark so both exercise the same path.
 */

import { runAgentWithTools, type AgentLoopOptions } from './agentLoop';
import { runOrchestrated } from './orchestratorRun';
import { runReviewPipeline } from './reviewPipeline';
import { asksForBugHunt } from './reviewCore';

/** Slash commands that force a run shape. */
export type RunKind = 'review' | 'cards' | 'plan-run';

/** Auto bug-hunt writes a report file, so it only starts when the mode may write. */
export function shouldRunReview(opts: Pick<AgentLoopOptions, 'task' | 'askMode' | 'planMode'>, runKind?: string): boolean {
	if (runKind === 'review') return true;
	if (runKind || opts.askMode || opts.planMode) return false;
	return asksForBugHunt(opts.task);
}

export async function runRouted(opts: AgentLoopOptions, runKind?: string): Promise<string> {
	if (shouldRunReview(opts, runKind)) {
		const reviewed = await runReviewPipeline(opts, { forced: true });
		if (reviewed) return reviewed;
		if (runKind === 'review') return runAgentWithTools(opts);
	}
	const orchestrated = await runOrchestrated(opts, { forced: !!runKind });
	if (orchestrated) return orchestrated;
	return runAgentWithTools(opts);
}
