import { assertLedger, decideCandidate } from './candidateGate';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const ceilingPlusGain = decideCandidate({
	byTask: {
		T2: { baseline: [100, 100, 100], candidate: [100, 100, 100] },
		T4: { baseline: [60, 62, 61], candidate: [90, 88, 92] },
	},
});
assert(ceilingPlusGain.decision === 'keep', 'ceiling task + clear gain keeps');

const noisyOnePass = decideCandidate({
	byTask: {
		T2: { baseline: [100, 91, 91], candidate: [100, 40, 100] },
		T4: { baseline: [100, 100, 100], candidate: [100, 100, 100] },
		CS2: { baseline: [100, 100, 100], candidate: [100, 100, 100] },
		CS3: { baseline: [100, 100, 90], candidate: [100, 100, 100] },
	},
});
assert(noisyOnePass.decision === 'revert', 'noisy one-pass style arm reverts');

const regress = decideCandidate({
	byTask: {
		T2: { baseline: [100, 100, 100], candidate: [40, 40, 100] },
		T4: { baseline: [80, 80, 80], candidate: [95, 95, 95] },
	},
});
assert(regress.decision === 'revert', 'task regression reverts even if other task gains');

const thin = decideCandidate({
	byTask: { T2: { baseline: [40], candidate: [90] } },
});
assert(thin.decision === 'revert', 'one rep reverts');

const okLedger = assertLedger({
	expected: ['T2-r1', 'T2-r2'],
	recorded: ['T2-r2', 'T2-r1'],
});
assert(okLedger.ok, 'ledger accepts same labels unsorted');

const badLedger = assertLedger({
	expected: ['T2-r1', 'T2-r2'],
	recorded: ['T2-r1'],
	unscored: ['T2-r2'],
});
assert(!badLedger.ok && /unscored/.test(badLedger.reason), 'unscored blocks decision');

console.log('candidateGate.selftest: ok');
