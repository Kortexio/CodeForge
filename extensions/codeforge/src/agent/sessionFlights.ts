/**
 * Per-session abort handles capped by llama.cpp slotCap().
 * Same session never has two streams; another session under the cap starts a new loop.
 *
 * UNTESTED end-to-end (manual / live llama.cpp parallel>1): unit coverage only.
 * Re-verify before relying on concurrent tabs, Agents+side-chat, or parallel delegate_task.
 */

export interface FlightHandle {
	abort: AbortController;
	cancelled: boolean;
	subAborts: Map<string, AbortController>;
}

export function newFlightHandle(): FlightHandle {
	return {
		abort: new AbortController(),
		cancelled: false,
		subAborts: new Map(),
	};
}

export function shouldPaint(ownerSessionId: string, visibleSessionId: string | null): boolean {
	return !!visibleSessionId && ownerSessionId === visibleSessionId;
}

export class SessionFlightRegistry {
	private readonly flights = new Map<string, FlightHandle>();

	constructor(private readonly capFn: () => number) {}

	cap(): number {
		return Math.max(1, Math.floor(this.capFn()) || 1);
	}

	size(): number {
		return this.flights.size;
	}

	has(sessionId: string): boolean {
		return this.flights.has(sessionId);
	}

	get(sessionId: string): FlightHandle | undefined {
		return this.flights.get(sessionId);
	}

	ids(): string[] {
		return [...this.flights.keys()];
	}

	/** This session is idle and a slot is free. */
	canStart(sessionId: string): boolean {
		if (this.flights.has(sessionId)) return false;
		return this.flights.size < this.cap();
	}

	start(sessionId: string, handle: FlightHandle = newFlightHandle()): FlightHandle | undefined {
		if (!this.canStart(sessionId)) return undefined;
		this.flights.set(sessionId, handle);
		return handle;
	}

	end(sessionId: string): FlightHandle | undefined {
		const h = this.flights.get(sessionId);
		this.flights.delete(sessionId);
		return h;
	}

	abort(sessionId: string): boolean {
		const h = this.flights.get(sessionId);
		if (!h) return false;
		h.cancelled = true;
		h.abort.abort();
		for (const sub of h.subAborts.values()) {
			sub.abort();
		}
		return true;
	}

	abortSub(subId: string): boolean {
		for (const h of this.flights.values()) {
			const sub = h.subAborts.get(subId);
			if (sub) {
				sub.abort();
				return true;
			}
		}
		return false;
	}

	registerSub(sessionId: string, subId: string, abort: AbortController | undefined): void {
		const h = this.flights.get(sessionId);
		if (!h) return;
		if (abort) h.subAborts.set(subId, abort);
		else h.subAborts.delete(subId);
	}
}
