import { createThinkingEscalation } from './thinkingEscalation';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const e = createThinkingEscalation({ maxPerTurn: 3 });
assert(!e.nextRoundThinks(), 'no event → no escalate');
e.note('edit_miss');
assert(e.nextRoundThinks(), 'one event → next round thinks');
assert(!e.nextRoundThinks(), 'one-shot consumed');
assert(e.escalatedCount() === 1, 'count is 1');

// Multiple notes before the next round still escalate once.
e.note('oracle_red');
e.note('guardrail_refusal');
e.note('loop_note');
assert(e.nextRoundThinks(), '2nd escalation');
assert(!e.nextRoundThinks(), 'pending cleared');

e.note('finish_refused');
assert(e.nextRoundThinks(), '3rd escalation (cap)');
e.note('edit_miss');
assert(!e.nextRoundThinks(), 'cap reached');
assert(e.escalatedCount() === 3, 'count is 3');
assert(e.remaining() === 0, 'none remaining');

const off = createThinkingEscalation({ enabled: false });
off.note('edit_miss');
assert(!off.nextRoundThinks(), 'disabled never escalates');

console.log('thinkingEscalation.selftest: ok');
