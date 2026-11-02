import type { AgentActivityEvent } from '../agent/agentLoop';

export type LoopExit = 'budget' | 'stuck' | 'length' | 'done' | 'cancelled' | 'error';

/** Structured resume prompt sent by the Continue affordance after a step-budget exit. */
export const CONTINUE_TURN_PROMPT =
	'Continue the unfinished work from the previous turn. Pick up from the last tool results and remaining plan items.';

/** Receives the live progress of one turn run on behalf of another surface (Agents window). */
export interface TurnObserver {
	onActivity(event: AgentActivityEvent): void;
	onStatus(text: string): void;
}

export interface TurnOutcome {
	sessionId: string | null;
	reply: string;
	loopExit: LoopExit;
}

export type AgentsTurnResult = ({ kind: 'finished' } & TurnOutcome) | { kind: 'busy' };
