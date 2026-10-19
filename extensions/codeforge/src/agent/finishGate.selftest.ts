/**
 * Diagnose-only finish gate + spec self-check.
 */
import { isEffectfulTool, shouldRefuseDiagFinish, shouldRequestSpecSelfCheck } from './finishGate';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(isEffectfulTool('edit'), 'edit effectful');
assert(isEffectfulTool('browser_click'), 'click effectful');
assert(!isEffectfulTool('read'), 'read not effectful');
assert(!isEffectfulTool('browser_snapshot'), 'snapshot not effectful');

assert(
	shouldRefuseDiagFinish({
		effectfulCount: 0,
		anyToolCount: 5,
		diagFinishNudges: 0,
	}),
	'explore-only refuse'
);

assert(
	!shouldRefuseDiagFinish({
		effectfulCount: 0,
		anyToolCount: 5,
		diagFinishNudges: 0,
		blocked: true,
	}),
	'blocked allows'
);

assert(
	!shouldRefuseDiagFinish({
		effectfulCount: 1,
		anyToolCount: 5,
		diagFinishNudges: 0,
	}),
	'effectful allows'
);

assert(
	!shouldRefuseDiagFinish({
		effectfulCount: 0,
		anyToolCount: 0,
		diagFinishNudges: 0,
	}),
	'no tools allows (direct reply)'
);

assert(
	!shouldRefuseDiagFinish({
		effectfulCount: 0,
		anyToolCount: 3,
		diagFinishNudges: 0,
		planMode: true,
	}),
	'plan allows'
);

assert(
	!shouldRefuseDiagFinish({
		effectfulCount: 0,
		anyToolCount: 3,
		diagFinishNudges: 2,
		maxDiagFinishNudges: 2,
	}),
	'cap exhausted allows'
);

assert(
	shouldRefuseDiagFinish({
		effectfulCount: 0,
		anyToolCount: 3,
		diagFinishNudges: 1,
		maxDiagFinishNudges: 2,
	}),
	'second refuse still'
);

assert(
	shouldRequestSpecSelfCheck({
		verifiedGreen: true,
		writtenSourceCount: 1,
		readSpecCount: 1,
		writtenTestCount: 0,
		specCheckNudges: 0,
	}),
	'spec read + source change'
);

assert(
	!shouldRequestSpecSelfCheck({
		verifiedGreen: true,
		writtenSourceCount: 2,
		readSpecCount: 0,
		writtenTestCount: 0,
		specCheckNudges: 0,
	}),
	'no spec read → skip even if no tests'
);

assert(
	!shouldRequestSpecSelfCheck({
		verifiedGreen: true,
		writtenSourceCount: 1,
		readSpecCount: 1,
		writtenTestCount: 0,
		specCheckNudges: 1,
	}),
	'one-shot only'
);

assert(
	!shouldRequestSpecSelfCheck({
		verifiedGreen: false,
		writtenSourceCount: 1,
		readSpecCount: 1,
		writtenTestCount: 0,
		specCheckNudges: 0,
	}),
	'needs green'
);

assert(
	!shouldRequestSpecSelfCheck({
		verifiedGreen: true,
		writtenSourceCount: 1,
		readSpecCount: 1,
		writtenTestCount: 2,
		specCheckNudges: 0,
	}),
	'tests touched → skip even with spec'
);

console.log('finishGate.selftest: ok');
