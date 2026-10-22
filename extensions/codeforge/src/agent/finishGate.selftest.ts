/**
 * Diagnose-only finish gate + spec self-check + runtime verify.
 */
import {
	countsAsRuntimeObserve,
	isEffectfulTool,
	isOracleBuildOrTestCommand,
	shouldRefuseDiagFinish,
	shouldRequestRuntimeVerify,
	shouldRequestSpecSelfCheck,
} from './finishGate';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(isEffectfulTool('edit'), 'edit effectful');
assert(isEffectfulTool('browser_click'), 'click effectful');
assert(!isEffectfulTool('read'), 'read not effectful');
assert(!isEffectfulTool('browser_snapshot'), 'snapshot not effectful');
assert(isEffectfulTool('shell', 'npm test'), 'mutating shell effectful');
assert(!isEffectfulTool('shell', 'dir src'), 'readonly shell not effectful');
assert(!isEffectfulTool('shell', 'git status'), 'git status not effectful');
assert(!isEffectfulTool('shell', 'type README.md'), 'type not effectful');
assert(!countsAsRuntimeObserve('shell', 'dir'), 'readonly shell not runtime observe');
assert(isOracleBuildOrTestCommand('dotnet test'), 'dotnet test is oracle');
assert(
	!isOracleBuildOrTestCommand('echo npm test was mentioned', ['npm test']),
	'oracle match requires full command'
);

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

assert(isOracleBuildOrTestCommand('npm test --silent'), 'npm test is oracle');
assert(isOracleBuildOrTestCommand('dotnet build Foo.sln -nologo -v q'), 'dotnet build is oracle');
assert(!isOracleBuildOrTestCommand('npm start'), 'npm start is runtime');
assert(
	countsAsRuntimeObserve('browser_snapshot'),
	'snapshot counts (even if not effectful)'
);
assert(countsAsRuntimeObserve('shell', 'npm start'), 'start shell counts');
assert(!countsAsRuntimeObserve('shell', 'npm test --silent'), 'test shell does not count');

assert(
	shouldRequestRuntimeVerify({
		verifiedGreen: true,
		writtenSourceCount: 1,
		runtimeObserveCount: 0,
		runtimeVerifyNudges: 0,
	}),
	'runtime verify fires'
);

assert(
	!shouldRequestRuntimeVerify({
		verifiedGreen: true,
		writtenSourceCount: 1,
		runtimeObserveCount: 1,
		runtimeVerifyNudges: 0,
	}),
	'already observed → skip'
);

assert(
	!shouldRequestRuntimeVerify({
		verifiedGreen: true,
		writtenSourceCount: 0,
		runtimeObserveCount: 0,
		runtimeVerifyNudges: 0,
	}),
	'no writes → skip'
);

assert(
	!shouldRequestRuntimeVerify({
		verifiedGreen: false,
		writtenSourceCount: 1,
		runtimeObserveCount: 0,
		runtimeVerifyNudges: 0,
	}),
	'needs green'
);

assert(
	!shouldRequestRuntimeVerify({
		verifiedGreen: true,
		writtenSourceCount: 1,
		runtimeObserveCount: 0,
		runtimeVerifyNudges: 1,
	}),
	'one-shot only'
);

console.log('finishGate.selftest: ok');
