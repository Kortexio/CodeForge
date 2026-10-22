/**
 * Harness revision must not keep an unmeasured or losing edit.
 */
import {
	applyHarnessEdit,
	applyHarnessKnobs,
	bootstrapMeanLowerBound,
	decideRevision,
	emptyHarnessArtifact,
	executeHarnessRevision,
	formatExecutionReport,
	holdoutRegressed,
	learnedHarnessBlock,
	parseProposerEdit,
} from './harnessRevision';
import type { ProtocolRollup } from './protocolTelemetry';
import { emptyProtocolCounters } from './protocolTelemetry';
import { defaultModelProfile } from './modelProfile';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

export async function run(): Promise<void> {
const empty = emptyHarnessArtifact();
assert(learnedHarnessBlock(empty) === '', 'empty artifact adds no prompt');

const banned = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'match phrases',
		sections: { writePolicy: 'If the user says fix it, write the file.' },
	})
);
assert(!banned.ok, 'phrase matcher rejected');

const skipTests = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'avoid checks',
		sections: { workflow: 'You may skip tests when stuck.' },
	})
);
assert(!skipTests.ok, 'skip tests rejected');

const massOff = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'turn off gate',
		knobs: { enforceMassRewriteGate: false },
	})
);
assert(!massOff.ok, 'mass rewrite false rejected');

const writeZero = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'no cap',
		knobs: { writeMaxContentLines: 0 },
	})
);
assert(!writeZero.ok, 'write cap below 40 rejected');

const unknown = parseProposerEdit(
	JSON.stringify({ diagnosis: 'x', sections: { oracle: 'disable' } })
);
assert(!unknown.ok && unknown.ok === false && /unknown section/.test(unknown.error), 'unknown section rejected');

const prose = parseProposerEdit('I would add a retry loop.');
assert(!prose.ok, 'prose rejected');

const nestedKnobs = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'writes too large',
		sections: {
			writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.',
			knobs: { writeMaxContentLines: 90 },
		},
	})
);
assert(nestedKnobs.ok && nestedKnobs.ok === true && nestedKnobs.edit.knobs.writeMaxContentLines === 90, 'knobs nested in sections are lifted');

const wrapped = parseProposerEdit(
	'<think>maybe {"diagnosis":"ignore this","sections":{}}</think>\n{"diagnosis":"writes too large","sections":{"writePolicy":"Write a skeleton under 40 lines, then grow it with edit."}}'
);
assert(wrapped.ok && wrapped.ok === true && wrapped.edit.diagnosis === 'writes too large', 'think block is ignored');

const okEdit = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'writes exceed the token budget',
		sections: { writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.' },
		knobs: { writeMaxContentLines: 80 },
	})
);
assert(okEdit.ok, 'valid edit parsed');
if (!okEdit.ok) throw new Error('narrow');
const next = applyHarnessEdit(empty, okEdit.edit);
assert(next.revision === 1, 'revision bumps');
assert(next.sections.workflow === '', 'untouched section stays empty');
assert(next.sections.writePolicy.includes('skeleton'), 'write policy applied');
assert(learnedHarnessBlock(next).includes('Learned harness'), 'kept notes render');

const profile = applyHarnessKnobs(defaultModelProfile('s', 'm'), next);
assert(profile.mutations.writeMaxContentLines === 80, 'knob applied');
assert(profile.mutations.enforceMassRewriteGate === true, 'other knobs stay');

const thin = decideRevision({
	byTask: { T2: { parent: [40], candidate: [90] } },
});
assert(thin.decision === 'revert', 'one rep does not keep');

const noise = decideRevision({
	byTask: {
		T2: { parent: [70, 72, 71], candidate: [71, 72, 70] },
		T4: { parent: [68, 69, 70], candidate: [69, 68, 69] },
	},
});
assert(noise.decision === 'revert', 'small noisy paired gains do not keep');

const equalNoise = decideRevision({
	byTask: {
		T2: { parent: [70, 71, 72], candidate: [70, 71, 72] },
		T4: { parent: [65, 66, 67], candidate: [65, 66, 67] },
	},
});
assert(equalNoise.decision === 'revert', 'identical parent and candidate revert');

const gain = decideRevision({
	byTask: {
		T2: { parent: [60, 62, 61], candidate: [80, 78, 82] },
		T4: { parent: [55, 56, 54], candidate: [75, 76, 74] },
	},
});
assert(gain.decision === 'keep', 'clear gain keeps');

const deltas = [2, 2, 2];
assert(bootstrapMeanLowerBound(deltas) > 0, 'positive deltas lower bound > 0');
assert(bootstrapMeanLowerBound([0, 0, 0]) <= 0, 'zero deltas lower bound not positive');

const holdFail = holdoutRegressed(
	{ CS2: { parent: [80, 82], candidate: [] } },
	{ CS2: { parent: [], candidate: [70, 71] } }
);
assert(!!holdFail && holdFail.includes('CS2'), 'holdout regression detected');

const rollupRecentOnly: ProtocolRollup = {
	serverId: 's',
	model: 'm',
	updatedAt: '2026-01-01',
	runCount: 100,
	sums: { ...emptyProtocolCounters(), nativeToolCalls: 999, badArgs: 999 },
	recent: [
		{
			at: '2026-01-01',
			serverId: 's',
			model: 'm',
			source: 'bench',
			loopExit: 'done',
			elapsedMs: 1,
			protocol: { ...emptyProtocolCounters(), nativeToolCalls: 2, badArgs: 1 },
			sampleCount: 0,
			sampleReasons: [],
		},
	],
};
assert(formatExecutionReport(rollupRecentOnly).includes('nativeToolCalls=2'), 'report uses recent runs only');
assert(!formatExecutionReport(rollupRecentOnly).includes('nativeToolCalls=999'), 'report ignores lifetime sums');

let scoreCalls = 0;
const lost = await executeHarnessRevision({
	artifact: empty,
	report: 'badArgs=20 lengthExits=4',
	propose: async () =>
		JSON.stringify({
			diagnosis: 'writes too large',
			sections: { writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.' },
		}),
	score: async input => {
		scoreCalls += 1;
		if (input.phase === 'parent') {
			return { byTask: { T2: { parent: [70, 70, 70], candidate: [] } } };
		}
		return { byTask: { T2: { parent: [70, 70, 70], candidate: [40, 40, 40] } } };
	},
	now: '2026-10-21T00:00:00.000Z',
});
assert(scoreCalls === 2, 'parent and paired were scored');
assert(!lost.kept, 'losing revision reverted');
assert(lost.artifact.sections.writePolicy === '', 'parent text restored');
assert(lost.artifact.history.length === 1 && lost.artifact.history[0].decision === 'revert', 'revert recorded');

scoreCalls = 0;
const won = await executeHarnessRevision({
	artifact: empty,
	report: 'badArgs=20 lengthExits=4',
	propose: async () =>
		JSON.stringify({
			diagnosis: 'writes too large',
			sections: { writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.' },
		}),
	score: async input => {
		scoreCalls += 1;
		if (input.phase === 'parent') {
			return { byTask: { T2: { parent: [60, 61, 59], candidate: [] } } };
		}
		return { byTask: { T2: { parent: [60, 61, 59], candidate: [88, 90, 86] } } };
	},
	now: '2026-10-21T00:00:00.000Z',
});
assert(won.kept, 'winning revision kept');
assert(won.artifact.sections.writePolicy.includes('skeleton'), 'kept text is the candidate');
assert(won.artifact.revision === 1, 'kept revision is 1');

scoreCalls = 0;
const skipped = await executeHarnessRevision({
	artifact: empty,
	report: 'No protocol rollup for this model yet.',
	propose: async () => '{"diagnosis":"no evidence","sections":{},"knobs":{}}',
	score: async input => {
		scoreCalls += 1;
		return { byTask: { T2: { parent: [100, 100, 100], candidate: [] } } };
	},
});
assert(!skipped.kept && !skipped.scored && scoreCalls === 1, 'no evidence scores only the parent and does not keep');

let seenReport = '';
await executeHarnessRevision({
	artifact: empty,
	report: 'badArgs=0',
	parentOutcomes: () => [
		{
			task: 'T2-feature-coupon',
			score: 40,
			loopExit: 'budget',
			steps: 31,
			hiddenFailed: ['hidden: percent coupon'],
			checksFailed: [],
			replyTail: 'I need to stop the exploration loop and implement the solution.',
		},
	],
	propose: async messages => {
		seenReport = messages[1].content;
		return '{"diagnosis":"no evidence","sections":{},"knobs":{}}';
	},
	score: async () => ({ byTask: { T2: { parent: [40, 40, 40], candidate: [] } } }),
});
assert(seenReport.includes('T2-feature-coupon: score 40/100, loop exit budget'), 'proposer sees parent task outcomes');
assert(seenReport.includes('hidden tests failed: hidden: percent coupon'), 'proposer sees failed hidden tests');
assert(seenReport.includes('stop the exploration loop'), 'proposer sees the final reply');
assert(!seenReport.includes('31 tool steps'), 'budget exit does not double-count steps');

console.log('harnessRevision.selftest: ok');
}
