/**
 * Semaphore for concurrent llama.cpp generations (one slot per in-flight /v1).
 */

import { slotCap } from './llamaSlots';

export class LlmSlotGate {
	private live = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly capFn: () => number = slotCap) {}

	liveCount(): number {
		return this.live;
	}

	cap(): number {
		return Math.max(1, this.capFn());
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		const wait = (): Promise<void> =>
			new Promise<void>((resolve, reject) => {
				const onAbort = (): void => {
					cleanup();
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
				};
				const wake = (): void => {
					cleanup();
					resolve();
				};
				const cleanup = (): void => {
					const i = this.waiters.indexOf(wake);
					if (i >= 0) this.waiters.splice(i, 1);
					signal?.removeEventListener('abort', onAbort);
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				this.waiters.push(wake);
				signal?.addEventListener('abort', onAbort, { once: true });
			});

		while (this.live >= this.cap()) {
			await wait();
		}
		this.live += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.live = Math.max(0, this.live - 1);
			this.waiters.shift()?.();
		};
	}
}

const shared = new LlmSlotGate();

export function llmLiveCount(): number {
	return shared.liveCount();
}

export async function acquireLlmSlot(signal?: AbortSignal): Promise<() => void> {
	return shared.acquire(signal);
}

export async function withLlmSlot<T>(
	signal: AbortSignal | undefined,
	fn: () => Promise<T>
): Promise<T> {
	const release = await acquireLlmSlot(signal);
	try {
		return await fn();
	} finally {
		release();
	}
}

/** Run at most `concurrency` promises at once; results stay in input order. */
export async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (!items.length) return [];
	const n = Math.max(1, Math.min(concurrency, items.length));
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]!, i);
		}
	};
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}
