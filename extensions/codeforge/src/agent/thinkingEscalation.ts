/**
 * Structural thinking escalation: after a stumble, the next model round thinks.
 * Events come from tool/oracle outcomes — never from user/assistant text matchers.
 */

export type EscalationEvent =
	| 'guardrail_refusal'
	| 'oracle_red'
	| 'finish_refused'
	| 'edit_miss'
	| 'loop_note';

export type ThinkingEscalation = {
	note(event: EscalationEvent): void;
	/** Consume a one-shot flag: true only for the immediate next round. */
	nextRoundThinks(): boolean;
	/** Rounds that actually escalated this turn. */
	escalatedCount(): number;
	remaining(): number;
};

export function createThinkingEscalation(opts?: {
	maxPerTurn?: number;
	enabled?: boolean;
}): ThinkingEscalation {
	const max = Math.max(0, opts?.maxPerTurn ?? 6);
	const enabled = opts?.enabled !== false;
	let pending = false;
	let used = 0;

	return {
		note(event: EscalationEvent): void {
			if (!enabled) return;
			if (used >= max) return;
			void event;
			pending = true;
		},
		nextRoundThinks(): boolean {
			if (!enabled || !pending || used >= max) {
				pending = false;
				return false;
			}
			pending = false;
			used += 1;
			return true;
		},
		escalatedCount(): number {
			return used;
		},
		remaining(): number {
			return Math.max(0, max - used);
		},
	};
}
