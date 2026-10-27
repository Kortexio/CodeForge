/**
 * Harness revision must not keep an unmeasured or losing edit.
 */
import {
	applyHarnessEdit,
	applyHarnessKnobs,
	assertNoGraderVerdicts,
	bootstrapMeanLowerBound,
	decideRevision,
	emptyHarnessArtifact,
	executeHarnessRevision,
	type HarnessScoreResult,
	formatExecutionReport,
	formatTaskOutcomes,
	holdoutRegressed,
	learnedHarnessBlock,
	loadHarnessArtifact,
	parseComposeChoice,
	parseProposerEdit,
	filterEditToDimension,
	stampScreen,
	artifactHasContent,
	saveHarnessArtifact,
	screenForScoring,
	decideTransfer,
	executeSequentialRevision,
	transferPrecheck,
	type TaskOutcome,
} from './harnessRevision';
import type { ProtocolRollup } from './protocolTelemetry';
import { emptyProtocolCounters } from './protocolTelemetry';
import { defaultModelProfile } from './modelProfile';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

export async function run(): Promise<void> {
const empty = emptyHarnessArtifact();
assert(learnedHarnessBlock(empty) === '', 'empty artifact adds no prompt');

const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-legacy-'));
const legacyPath = path.join(legacyDir, 'harness.json');
fs.writeFileSync(
	legacyPath,
	JSON.stringify({
		version: 1,
		revision: 1,
		sections: {
			workflow: 'Immediately test require("./index").applyCoupon after writes.',
			writePolicy: '',
			toolContract: '',
		},
		knobs: {},
		history: [],
	}),
	'utf8'
);
const legacy = loadHarnessArtifact('s', 'm', legacyPath);
assert(legacy.sections.workflow === '', 'legacy without screen is quarantined');
assert(learnedHarnessBlock(legacy) === '', 'legacy without screen adds no prompt');
fs.rmSync(legacyDir, { recursive: true, force: true });

const fixtureHit = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'export missing',
		sections: { workflow: 'Call applyCoupon after every write.' },
		evidence: { workflow: [{ run: 'T2-r1', step: 2 }] },
	}),
	{ forbiddenTokens: ['applyCoupon'], knownRuns: { 'T2-r1': 10 } }
);
assert(!fixtureHit.ok, 'fixture identifier rejected');

const noEvidence = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'writes too large',
		sections: { writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.' },
	}),
	{ knownRuns: { 'T2-r1': 10 }, requireEvidence: true }
);
assert(!noEvidence.ok && /evidence/i.test(noEvidence.error), 'missing evidence rejected');

const badStep = parseProposerEdit(
	JSON.stringify({
		diagnosis: 'writes too large',
		sections: { writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.' },
		evidence: { writePolicy: [{ run: 'T2-r1', step: 99 }] },
	}),
	{ knownRuns: { 'T2-r1': 10 } }
);
assert(!badStep.ok && /outside run/i.test(badStep.error), 'out-of-range step rejected');

assert(
	assertNoGraderVerdicts('T2: score 40/100', []) === 'report contains grader verdict fields',
	'score tripwire'
);
const hiddenLeak = assertNoGraderVerdicts('failed: valid on its expiry day', [
	'valid on its expiry day',
]);
assert(!!hiddenLeak && hiddenLeak.includes('hidden test'), 'hidden-name tripwire');

const screened = stampScreen(
	{
		...empty,
		revision: 1,
		sections: {
			...empty.sections,
			writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.',
		},
	},
	3,
	'2026-10-25T00:00:00.000Z'
);
assert(learnedHarnessBlock(screened).includes('Learned harness'), 'screened artifact renders');
assert(
	!formatTaskOutcomes([
		{
			task: 'T2',
			score: 40,
			loopExit: 'budget',
			steps: 31,
			hiddenFailed: ['hidden: percent coupon'],
			checksFailed: [],
			replyTail: 'stop the exploration loop',
			toolLog: 'running Reading docs/pricing.md\nok Reading docs/pricing.md',
			runId: 'T2-r1',
		},
	]).includes('score 40'),
	'proposer outcomes hide scores'
);
assert(
	!formatTaskOutcomes([
		{
			task: 'T2',
			score: 40,
			hiddenFailed: ['hidden: percent coupon'],
			checksFailed: [],
			toolLog: 'ok',
			runId: 'T2-r1',
		},
	]).includes('hidden: percent coupon'),
	'proposer outcomes hide hidden names'
);

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
assert(
	learnedHarnessBlock(stampScreen(next, 0)).includes('Learned harness'),
	'kept notes render after screen'
);

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
assert(!!won.artifact.screen, 'kept revision is screened');

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
let proposeCalls = 0;
await executeHarnessRevision({
	artifact: empty,
	report: 'badArgs=0',
	forbiddenTokens: ['applyCoupon'],
	hiddenNames: ['valid on its expiry day'],
	parentOutcomes: () => [
		{
			task: 'T2-feature-coupon',
			score: 40,
			loopExit: 'budget',
			steps: 12,
			hiddenFailed: ['valid on its expiry day'],
			checksFailed: [],
			replyTail: 'I need to stop the exploration loop and implement the solution.',
			toolLog: 'running Reading docs/pricing.md\nok Reading docs/pricing.md',
			runId: 'T2-r1',
		},
	],
	propose: async messages => {
		proposeCalls += 1;
		seenReport = messages.map(m => m.content).join('\n');
		if (proposeCalls === 1) {
			return JSON.stringify({
				diagnosis: 'export missing',
				sections: { workflow: 'Call applyCoupon after writes.' },
				evidence: { workflow: [{ run: 'T2-r1', step: 1 }] },
			});
		}
		return '{"diagnosis":"no evidence","sections":{},"knobs":{}}';
	},
	score: async () => ({ byTask: { T2: { parent: [40, 40, 40], candidate: [] } } }),
});
assert(proposeCalls === 2, 'invalid proposal gets one retry');
assert(seenReport.includes('rejected'), 'retry includes rejection reason');
assert(!seenReport.includes('score 40'), 'proposer does not see scores');
assert(!seenReport.includes('valid on its expiry day'), 'proposer does not see hidden names');
assert(seenReport.includes('stop the exploration loop'), 'proposer sees the final reply');
assert(seenReport.includes('Trajectory:'), 'proposer sees trajectories');

const keepBase = parseComposeChoice(
	JSON.stringify({ choice: 'KEEP_BASE', diagnosis: 'no signal', sections: {}, knobs: {} })
);
assert(keepBase.ok && keepBase.choice === 'KEEP_BASE', 'compose KEEP_BASE');
const invOnly = filterEditToDimension(
	{
		diagnosis: 'x',
		sections: { workflow: 'a', writePolicy: 'b', toolContract: 'c' },
		knobs: {},
	},
	'INV'
);
assert(invOnly.sections.writePolicy === undefined, 'INV drops writePolicy');
assert(invOnly.sections.workflow === 'a' && invOnly.sections.toolContract === 'c', 'INV keeps procedure');

let ppcProposes = 0;
const ppc = await executeHarnessRevision({
	artifact: emptyHarnessArtifact(),
	report: 'loopExit=stuck',
	ppc: true,
	forbiddenTokens: [],
	hiddenNames: [],
	minRepsPerTask: 3,
	parentOutcomes: () => [
		{
			task: 'T2-feature-coupon',
			score: 40,
			hiddenFailed: [],
			checksFailed: [],
			toolLog: 'running Reading x\nok Reading x',
			runId: 'T2-r1',
		},
	],
	propose: async () => {
		ppcProposes += 1;
		if (ppcProposes <= 2) {
			return JSON.stringify({
				diagnosis: `dim-${ppcProposes}`,
				sections:
					ppcProposes === 1
						? { workflow: 'Use edit for small fixes.', toolContract: 'Prefer edit over write.' }
						: { writePolicy: 'Write a skeleton under 40 lines.' },
				evidence: {
					workflow: [{ run: 'T2-r1', step: 1 }],
					toolContract: [{ run: 'T2-r1', step: 1 }],
					writePolicy: [{ run: 'T2-r1', step: 1 }],
				},
			});
		}
		return JSON.stringify({
			choice: 'merge',
			diagnosis: 'compose merge',
			sections: {
				workflow: 'Use edit for small fixes.',
				toolContract: 'Prefer edit over write.',
				writePolicy: 'Write a skeleton under 40 lines.',
			},
			evidence: {
				workflow: [{ run: 'T2-r1', step: 1 }],
				toolContract: [{ run: 'T2-r1', step: 1 }],
				writePolicy: [{ run: 'T2-r1', step: 1 }],
			},
			knobs: {},
		});
	},
	scoreProbe: async ({ label }) => ({ summary: `probe-${label}` }),
	score: async (input): Promise<HarnessScoreResult> => {
		if (input.phase === 'parent') {
			return { byTask: { T2: { parent: [40, 40, 40], candidate: [] } } };
		}
		return {
			byTask: {
				T2: { parent: [40, 40, 40], candidate: [90, 90, 90] },
				T4: { parent: [40, 40, 40], candidate: [85, 85, 85] },
			},
		};
	},
});
assert(ppcProposes === 3, 'PPC proposes INV, DOM, then compose');
assert(ppc.kept && ppc.diagnosis === 'compose merge', 'PPC merge kept when gate clears');

// Sequential recursion: step 2 starts from step 1's kept artifact; a revert stays in history.
{
	const seqOutcome = (): TaskOutcome[] => [
		{ task: 'T2', score: 50, hiddenFailed: [], checksFailed: [], toolLog: 'ok a\nok b', runId: 'T2-r1' },
	];
	const parentsSeen: Array<{ step: number; revision: number; writePolicy: string }> = [];
	const proposerPrompts: string[] = [];
	let call = 0;
	const seq = await executeSequentialRevision({
		artifact: emptyHarnessArtifact(),
		steps: 3,
		report: 'loopExit=budget',
		parentOutcomes: seqOutcome,
		beforeStep: (step, parent) => {
			parentsSeen.push({ step, revision: parent.revision, writePolicy: parent.sections.writePolicy });
		},
		propose: async messages => {
			call += 1;
			proposerPrompts.push(messages.map(m => m.content).join('\n'));
			return JSON.stringify({
				diagnosis: `step-diag-${call}`,
				sections: { writePolicy: `Write a skeleton under ${30 + call} lines.` },
				evidence: { writePolicy: [{ run: 'T2-r1', step: 1 }] },
			});
		},
		score: async input => {
			if (input.phase === 'parent') return { byTask: { T2: { parent: [50, 50, 50], candidate: [] } } };
			// Step 1 wins clearly; steps 2 and 3 tie the parent exactly.
			if (input.parent.revision === 0) {
				return { byTask: { T2: { parent: [50, 51, 49], candidate: [80, 82, 81] } } };
			}
			return { byTask: { T2: { parent: [80, 81, 82], candidate: [80, 81, 82] } } };
		},
	});
	assert(seq.steps.length === 3, 'three sequential steps ran');
	assert(seq.steps[0].kept, 'step 1 kept on clear gain');
	assert(parentsSeen[1].revision === 1, 'step 2 parent is the step-1 kept revision');
	assert(parentsSeen[1].writePolicy.includes('31 lines'), 'step 2 parent carries step-1 text');
	assert(!seq.steps[1].kept, 'tie on step 2 reverts');
	assert(parentsSeen[2].revision === 1, 'after a revert the parent revision is unchanged');
	assert(
		proposerPrompts[2].includes('step-diag-2') && proposerPrompts[2].includes('revert'),
		'step 3 proposer sees the step-2 revert in history'
	);
	assert(seq.final.revision === 1 && seq.final.sections.writePolicy.includes('31 lines'), 'final is the last kept');
}

// afterStep (holdout) can veto a keep, and the next step starts from the vetoed parent.
{
	let seqCall = 0;
	const vetoed = await executeSequentialRevision({
		artifact: emptyHarnessArtifact(),
		steps: 2,
		report: 'x',
		parentOutcomes: () => [
			{ task: 'T2', score: 1, hiddenFailed: [], checksFailed: [], toolLog: 'ok', runId: 'T2-r1' },
		],
		propose: async () => {
			seqCall += 1;
			return JSON.stringify({
				diagnosis: `d${seqCall}`,
				sections: { writePolicy: 'Write a skeleton under 40 lines.' },
				evidence: { writePolicy: [{ run: 'T2-r1', step: 1 }] },
			});
		},
		score: async input =>
			input.phase === 'parent'
				? { byTask: { T2: { parent: [50, 50, 50], candidate: [] } } }
				: { byTask: { T2: { parent: [50, 51, 49], candidate: [80, 82, 81] } } },
		afterStep: (_step, outcome, parent) =>
			outcome.kept
				? { ...outcome, kept: false, reason: 'holdout: CS2 dropped', artifact: parent }
				: outcome,
	});
	assert(vetoed.steps.every(s => !s.kept), 'holdout veto reverts every step');
	assert(vetoed.final.revision === 0 && !artifactHasContent(vetoed.final), 'vetoed loop keeps the empty parent');
}

// A grader-verdict leak ends the loop instead of running more steps.
{
	let leakScores = 0;
	const leaked = await executeSequentialRevision({
		artifact: emptyHarnessArtifact(),
		steps: 3,
		report: 'T2: score 40/100',
		propose: async () => '{"diagnosis":"no evidence","sections":{},"knobs":{}}',
		score: async () => {
			leakScores += 1;
			return { byTask: { T2: { parent: [40, 40, 40], candidate: [] } } };
		},
	});
	assert(leaked.steps.length === 1 && leaked.steps[0].leak === true, 'leak stops after one step');
	assert(leakScores === 1, 'leak step scored only the parent');
}

// A scored candidate must reach the prompt once written and reloaded.
{
	const candidate = applyHarnessEdit(emptyHarnessArtifact(), {
		diagnosis: 'd',
		sections: { writePolicy: 'Write a skeleton under 40 lines, then grow it with edit.' },
		knobs: { writeMaxContentLines: 90 },
	});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-score-'));
	const raw = path.join(dir, 'raw.json');
	saveHarnessArtifact(candidate, raw);
	assert(learnedHarnessBlock(loadHarnessArtifact('s', 'm', raw)) === '', 'unscreened candidate loads empty');
	const screenedCand = screenForScoring(candidate, ['applyCoupon']);
	assert(screenedCand.ok, 'clean candidate is screened for scoring');
	if (!screenedCand.ok) throw new Error('narrow');
	const fp = path.join(dir, 'cand.json');
	saveHarnessArtifact(screenedCand.artifact, fp);
	const loaded = loadHarnessArtifact('s', 'm', fp);
	assert(learnedHarnessBlock(loaded).includes('skeleton'), 'screened candidate reaches the prompt');
	assert(loaded.knobs.writeMaxContentLines === 90, 'screened candidate keeps its knobs');
	const dirty = screenForScoring(
		applyHarnessEdit(emptyHarnessArtifact(), {
			diagnosis: 'd',
			sections: { workflow: 'Check applyCoupon first.' },
			knobs: {},
		}),
		['applyCoupon']
	);
	assert(!dirty.ok, 'candidate with a fixture token is refused');
	fs.rmSync(dir, { recursive: true, force: true });
}

// Transfer: no content or a target fixture token is NotRun; worse or equal never keeps.
{
	const emptyCheck = transferPrecheck(emptyHarnessArtifact(), []);
	assert(!emptyCheck.ok && emptyCheck.status === 'NotRun', 'empty artifact has nothing to transfer');
	const learned = stampScreen(
		{
			...emptyHarnessArtifact(),
			revision: 2,
			sections: { workflow: '', toolContract: '', writePolicy: 'Run ApplyCoupon tests first.' },
		},
		1
	);
	const hit = transferPrecheck(learned, ['ApplyCoupon']);
	assert(!hit.ok && /ApplyCoupon/.test(hit.reason), 'target fixture token blocks transfer');
	assert(transferPrecheck(learned, ['VipRate']).ok, 'clean artifact may transfer');

	const worse = decideTransfer({
		CS2: { empty: [90, 91, 92], learned: [70, 71, 72] },
		CS3: { empty: [80, 80, 80], learned: [85, 86, 84] },
	});
	assert(worse.decision === 'revert', 'a task regression blocks transfer');
	const tie = decideTransfer({ CS3: { empty: [80, 81, 82], learned: [80, 81, 82] } });
	assert(tie.decision === 'revert', 'equal scores do not count as transfer');
	const thinTransfer = decideTransfer({ CS3: { empty: [40], learned: [90] } });
	assert(thinTransfer.decision === 'revert', 'one rep never counts as transfer');
	const gainTransfer = decideTransfer({
		CS2: { empty: [60, 61, 59], learned: [80, 82, 81] },
		CS3: { empty: [55, 56, 54], learned: [75, 76, 74] },
	});
	assert(gainTransfer.decision === 'keep', 'clear paired gain counts as transfer');
}

console.log('harnessRevision.selftest: ok');
}

if (require.main === module) {
	run().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
