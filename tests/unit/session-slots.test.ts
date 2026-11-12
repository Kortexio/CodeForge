import { SessionFlightRegistry, newFlightHandle, shouldPaint } from '../../extensions/codeforge/src/agent/sessionFlights';
import { LlmSlotGate, mapPool } from '../../extensions/codeforge/src/agent/llmSlotGate';
import { runWithJournalContext, journalContext } from '../../extensions/codeforge/src/agent/journalContext';
import { nestSubtask, type TaskData } from '../../extensions/codeforge/src/views/taskData';
import { TurnWaiterRegistry, appendAssistantThought } from '../../extensions/codeforge/src/views/turnWaiters';
import type { TurnOutcome } from '../../extensions/codeforge/src/views/turnContract';
import {
	clearLlamaSlotCache,
	seedLlamaSlotCache,
	slotCap,
} from '../../extensions/codeforge/src/agent/llamaSlots';

describe('slotCap', () => {
	afterEach(() => clearLlamaSlotCache());

	it('is 1 if unprobed', () => {
		expect(slotCap()).toBe(1);
		expect(slotCap('lan', 'qwen')).toBe(1);
	});

	it('uses probed parallel for the matching pair', () => {
		seedLlamaSlotCache('lan', 'qwen', { parallel: 2, slotContext: 32768, kvUnified: false });
		expect(slotCap()).toBe(2);
		expect(slotCap('lan', 'qwen')).toBe(2);
		expect(slotCap('other', 'qwen')).toBe(1);
	});
});

describe('SessionFlightRegistry', () => {
	it('cap=2: two sessions both get a live abort; the second does not abort the first', () => {
		const flights = new SessionFlightRegistry(() => 2);
		const a = flights.start('A')!;
		const b = flights.start('B')!;
		expect(a.abort.signal.aborted).toBe(false);
		expect(b.abort.signal.aborted).toBe(false);
		expect(flights.start('A')).toBeUndefined();
		flights.abort('B');
		expect(a.abort.signal.aborted).toBe(false);
		expect(b.abort.signal.aborted).toBe(true);
		flights.end('B');
		expect(flights.canStart('C')).toBe(true);
	});

	it('cap=1: second session cannot start (Agents busy)', () => {
		const flights = new SessionFlightRegistry(() => 1);
		expect(flights.start('A')).toBeTruthy();
		expect(flights.canStart('B')).toBe(false);
		expect(flights.start('B')).toBeUndefined();
	});

	it('visible-tab busy is true only for the active running session', () => {
		const flights = new SessionFlightRegistry(() => 2);
		flights.start('A');
		flights.start('B');
		expect(shouldPaint('A', 'A')).toBe(true);
		expect(shouldPaint('B', 'A')).toBe(false);
		expect(flights.has('A') && shouldPaint('A', 'A')).toBe(true);
		expect(flights.has('B') && shouldPaint('B', 'A')).toBe(false);
	});

	it('cancel of sub-1 does not abort sub-2', () => {
		const flights = new SessionFlightRegistry(() => 2);
		const parent = flights.start('sess')!;
		const s1 = new AbortController();
		const s2 = new AbortController();
		flights.registerSub('sess', 'sess-sub-1', s1);
		flights.registerSub('sess', 'sess-sub-2', s2);
		expect(flights.abortSub('sess-sub-1')).toBe(true);
		expect(s1.signal.aborted).toBe(true);
		expect(s2.signal.aborted).toBe(false);
		expect(parent.abort.signal.aborted).toBe(false);
	});
});

describe('LlmSlotGate + mapPool', () => {
	it('two workers overlap when cap>=2', async () => {
		const gate = new LlmSlotGate(() => 2);
		let live = 0;
		let maxLive = 0;
		const run = async (): Promise<void> => {
			const release = await gate.acquire();
			live += 1;
			maxLive = Math.max(maxLive, live);
			await new Promise(r => setTimeout(r, 30));
			live -= 1;
			release();
		};
		await Promise.all([run(), run()]);
		expect(maxLive).toBe(2);
	});

	it('mapPool runs two delegate jobs at once', async () => {
		let live = 0;
		let maxLive = 0;
		const overlapping: number[] = [];
		await mapPool([1, 2], 2, async (n) => {
			live += 1;
			maxLive = Math.max(maxLive, live);
			overlapping.push(n);
			await new Promise(r => setTimeout(r, 20));
			live -= 1;
			return n;
		});
		expect(maxLive).toBe(2);
		expect(overlapping.sort()).toEqual([1, 2]);
	});
});

describe('journal ALS', () => {
	it('overlapping async work keeps session identity', async () => {
		const seen: string[] = [];
		const a = runWithJournalContext({ sessionId: 'A', turn: 1 }, async () => {
			await new Promise(r => setTimeout(r, 15));
			seen.push(journalContext()!.sessionId);
		});
		const b = runWithJournalContext({ sessionId: 'B', turn: 2 }, async () => {
			seen.push(journalContext()!.sessionId);
		});
		await Promise.all([a, b]);
		expect(seen).toContain('A');
		expect(seen).toContain('B');
	});
});

describe('tasks tree nest', () => {
	it('parent has nested running children', () => {
		const tasks: TaskData[] = [
			{ id: 'sess', name: 'parent', status: 'running' },
		];
		expect(
			nestSubtask(tasks, {
				id: 'sess-sub-1',
				name: '[sub] explore',
				status: 'running',
			})
		).toBe(true);
		expect(tasks[0]!.subtasks).toHaveLength(1);
		expect(tasks[0]!.subtasks![0]!.id).toBe('sess-sub-1');
		expect(tasks).toHaveLength(1);
	});
});

describe('newFlightHandle', () => {
	it('starts uncancelled', () => {
		const h = newFlightHandle();
		expect(h.cancelled).toBe(false);
		expect(h.abort.signal.aborted).toBe(false);
	});
});

describe('TurnWaiterRegistry', () => {
	it('settling A does not resolve B', () => {
		const waiters = new TurnWaiterRegistry();
		const settled: string[] = [];
		const obs = { onActivity: () => undefined, onStatus: () => undefined };
		waiters.register('A', o => settled.push(`A:${o.reply}`), obs);
		waiters.register('B', o => settled.push(`B:${o.reply}`), obs);
		const outA: TurnOutcome = { sessionId: 'A', reply: 'from-a', loopExit: 'done' };
		expect(waiters.settle('A', outA)).toBe(true);
		expect(settled).toEqual(['A:from-a']);
		expect(waiters.has('B')).toBe(true);
		expect(waiters.settle('B', { sessionId: 'B', reply: 'from-b', loopExit: 'done' })).toBe(true);
		expect(settled).toEqual(['A:from-a', 'B:from-b']);
	});

	it('routes observer by session id', () => {
		const waiters = new TurnWaiterRegistry();
		const seen: string[] = [];
		waiters.register(
			'A',
			() => undefined,
			{ onActivity: () => seen.push('A'), onStatus: t => seen.push(`A:${t}`) }
		);
		waiters.register(
			'B',
			() => undefined,
			{ onActivity: () => seen.push('B'), onStatus: t => seen.push(`B:${t}`) }
		);
		waiters.observer('B')?.onStatus('hi');
		waiters.observer('A')?.onActivity({} as never);
		expect(seen).toEqual(['B:hi', 'A']);
	});
});

describe('activity isolation', () => {
	it('activity for B does not mutate A messages', () => {
		type Msg = { role: string; content: string; reasoning?: string };
		const bySession = new Map<string, { messages: Msg[] }>([
			['A', { messages: [{ role: 'assistant', content: 'a-pending', reasoning: 'keep' }] }],
			['B', { messages: [{ role: 'assistant', content: 'b-pending' }] }],
		]);
		appendAssistantThought(bySession, 'B', 'thought-b');
		expect(bySession.get('A')!.messages[0]!.reasoning).toBe('keep');
		expect(bySession.get('A')!.messages[0]!.content).toBe('a-pending');
		expect(bySession.get('B')!.messages[0]!.reasoning).toBe('thought-b');
	});
});
