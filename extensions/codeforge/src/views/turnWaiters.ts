/**
 * Per-session Agents-window waiters. Settling session A must not resolve session B.
 */

import type { TurnObserver, TurnOutcome } from './turnContract';

interface Waiter {
	settle: (outcome: TurnOutcome) => void;
	observer: TurnObserver;
}

export class TurnWaiterRegistry {
	private readonly waiters = new Map<string, Waiter>();

	register(sessionId: string, settle: (outcome: TurnOutcome) => void, observer: TurnObserver): void {
		this.waiters.set(sessionId, { settle, observer });
	}

	observer(sessionId: string | null | undefined): TurnObserver | undefined {
		if (!sessionId) return undefined;
		return this.waiters.get(sessionId)?.observer;
	}

	/** Resolve only the waiter for this sessionId. */
	settle(sessionId: string | null | undefined, outcome: TurnOutcome): boolean {
		if (!sessionId) return false;
		const w = this.waiters.get(sessionId);
		if (!w) return false;
		this.waiters.delete(sessionId);
		w.settle(outcome);
		return true;
	}

	clear(sessionId: string, observer?: TurnObserver): void {
		const w = this.waiters.get(sessionId);
		if (!w) return;
		if (observer && w.observer !== observer) return;
		this.waiters.delete(sessionId);
	}

	has(sessionId: string): boolean {
		return this.waiters.has(sessionId);
	}
}

/** Pure message-store helper: activity for B must not touch A's transcript. */
export function appendAssistantThought(
	bySession: Map<string, { messages: Array<{ role: string; content: string; reasoning?: string }> }>,
	ownerSessionId: string,
	detail: string
): void {
	const ui = bySession.get(ownerSessionId);
	if (!ui) return;
	const last = ui.messages[ui.messages.length - 1];
	if (!last || last.role !== 'assistant') return;
	last.reasoning = last.reasoning ? `${last.reasoning}\n\n${detail}` : detail;
}
