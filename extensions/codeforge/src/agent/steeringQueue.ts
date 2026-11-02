/**
 * Plano B: messages typed while the agent is running.
 * Steering is injected after the current tool batch, before the next model request.
 * Follow-up waits until the agent would stop, then starts another turn.
 */

export type QueueKind = 'steer' | 'followup';

export interface QueuedTurn {
	id: string;
	text: string;
	kind: QueueKind;
	mode?: string;
}

export class SteeringQueue {
	items: QueuedTurn[] = [];

	push(kind: QueueKind, text: string, id = `${Date.now()}-${this.items.length}`, mode?: string): QueuedTurn | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const item = { id, text: trimmed, kind, mode };
		this.items.push(item);
		return item;
	}

	remove(id: string): void {
		this.items = this.items.filter(item => item.id !== id);
	}

	clear(): void {
		this.items = [];
	}

	/** Take every steering note, leaving follow-ups in place. */
	drainSteering(): string[] {
		const notes = this.items.filter(item => item.kind === 'steer').map(item => item.text);
		this.items = this.items.filter(item => item.kind !== 'steer');
		return notes;
	}

	/** Next follow-up, if the agent has stopped. Steering is not returned here. */
	shiftFollowUp(): QueuedTurn | undefined {
		const index = this.items.findIndex(item => item.kind === 'followup');
		if (index < 0) return undefined;
		const [next] = this.items.splice(index, 1);
		return next;
	}
}
