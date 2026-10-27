/**
 * Unit checks for the experiment loop helpers (no test runner — run via npx tsx).
 */
import {
	CHECKS_LOCK_REL,
	HABIT_PROBATION_FEATURES,
	MAX_ACTIVE_HABITS,
	addHabitOnProbation,
	advanceHabitProbation,
	collectLockablePaths,
	denyExperimentMutation,
	emptyHabitsFile,
	featureKeyFromLock,
	formatChecksLock,
	formatRoundResultLine,
	HOW_TO_WORK_REL,
	isLockableCheckPath,
	isLockedScorePath,
	lockedScorePaths,
	ORACLE_JSON_REL,
	parseChecksLock,
	parseCoachHabit,
	parseRoundResults,
	planMayWritePath,
	renderHowToWork,
	shellMentionsLockedPath,
	shouldRunCoach,
	undoRate,
} from './experimentLoop';
import { profileForTurn } from './toolsets';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const lock = parseChecksLock(
	JSON.stringify({ paths: ['tests/OrderTests.cs', '.CodeForge/loop/checks/order.md'] })
);
assert(!!lock, 'parseChecksLock accepts paths');
const locked = lockedScorePaths(lock!);
assert(isLockedScorePath(ORACLE_JSON_REL, locked), 'oracle.json always locked');
assert(isLockedScorePath(CHECKS_LOCK_REL, locked), 'checks.lock always locked');
assert(isLockedScorePath('tests/OrderTests.cs', locked), 'listed check locked');
assert(isLockedScorePath('tests\\OrderTests.cs', locked), 'backslash path matches');
assert(!isLockedScorePath('src/App.cs', locked), 'app code not locked');

assert(
	shellMentionsLockedPath('type .CodeForge\\loop\\checks.lock', locked),
	'shell cites lock via basename'
);
assert(
	shellMentionsLockedPath('notepad tests/OrderTests.cs', locked),
	'shell cites locked check path'
);
assert(!shellMentionsLockedPath('dotnet build', locked), 'shell build does not hit lock');

assert(
	!!denyExperimentMutation('write', { path: 'tests/OrderTests.cs' }, {
		experimentActive: true,
		locked,
	})?.includes('locked'),
	'build denied writing locked check'
);
assert(
	!!denyExperimentMutation('shell', { command: 'del .CodeForge/oracle.json' }, {
		experimentActive: true,
		locked,
	})?.includes('locked'),
	'build shell denied touching oracle'
);
assert(
	denyExperimentMutation('write', { path: 'src/App.cs' }, {
		experimentActive: true,
		locked,
	}) === null,
	'build may write app code'
);
assert(
	denyExperimentMutation('write', { path: 'tests/OrderTests.cs' }, {
		experimentActive: true,
		planMode: true,
		locked,
	}) === null,
	'plan may revise locked checks'
);
assert(
	!!denyExperimentMutation('write', { path: 'src/App.cs' }, {
		experimentActive: false,
		planMode: true,
		locked: [],
	})?.includes('Plan mode'),
	'plan cannot write app code'
);
assert(planMayWritePath('src/tests/Order.cs', []), 'plan may draft test files');
assert(planMayWritePath('Order.test.ts', []), 'plan may draft *.test.ts');
assert(
	!!denyExperimentMutation('write', { path: 'src/App.cs' }, {
		experimentActive: true,
		coachMode: true,
		locked,
	})?.includes('JSON-only'),
	'coach cannot write app code'
);
assert(
	!!denyExperimentMutation('write', { path: HOW_TO_WORK_REL }, {
		experimentActive: true,
		coachMode: true,
		locked,
	})?.includes('JSON-only'),
	'coach cannot write how-to-work directly'
);

const line = formatRoundResultLine({
	kept: false,
	feature: 'shared projects',
	failedTests: ['ShareAddsTo100'],
	files: ['src/Share.cs'],
	at: '2026-10-03T00:00:00.000Z',
});
const parsed = parseRoundResults(line + '\n');
assert(parsed.length === 1 && parsed[0].kept === false, 'round result round-trips');
assert(
	shouldRunCoach([
		{ kept: false, feature: 'A', at: '1' },
		{ kept: true, feature: 'A', at: '2' },
	]),
	'coach when feature had an undo'
);
assert(
	!shouldRunCoach([
		{ kept: false, feature: 'old', at: '1' },
		{ kept: true, feature: 'new', at: '2' },
	]),
	'coach skips when latest feature was clean'
);
assert(
	!shouldRunCoach(
		[
			{ kept: false, feature: 'A', at: '1' },
			{ kept: true, feature: 'A', at: '2' },
		],
		{ featureKey: 'A@t1', coachedFeatures: ['A@t1'] }
	),
	'coach once per feature key'
);

assert(profileForTurn('implement', 'add feature', { coachMode: true }) === 'coach', 'coach profile');

assert(isLockableCheckPath('src/tests/Order.cs'), 'test path is lockable');
assert(isLockableCheckPath('.CodeForge/loop/checks/order.md'), 'loop check is lockable');
assert(!isLockableCheckPath(CHECKS_LOCK_REL), 'lock file itself is not lockable');
assert(!isLockableCheckPath('src/App.cs'), 'app code is not lockable');
assert(
	collectLockablePaths(['src/App.cs', 'src/tests/Order.cs', 'src/tests/Order.cs', CHECKS_LOCK_REL]).join(',') ===
		'src/tests/Order.cs',
	'collectLockablePaths keeps only score paths'
);
const autoLock = parseChecksLock(
	formatChecksLock({
		paths: ['src/tests/Order.cs'],
		feature: 'online ordering',
		lockedAt: '2026-10-03T00:00:00.000Z',
	})
);
assert(
	!!autoLock &&
		autoLock.paths[0] === 'src/tests/Order.cs' &&
		autoLock.feature === 'online ordering',
	'auto lock format round-trips with feature'
);
assert(
	featureKeyFromLock(autoLock!) === 'online ordering@2026-10-03T00:00:00.000Z',
	'feature key from lock'
);

const banned = parseCoachHabit(
	JSON.stringify({
		rounds: [{ id: 'r1', change: 'x', observed: 'y', verdict: 'hurt' }],
		habit: { cue: 'rewrite', habit: 'If the user says fix it, phrase match', evidence: ['r1'], confidence: 'low' },
	})
);
assert(!banned.ok && /forbidden/i.test(banned.error || ''), 'forbidden habit rejected');

const noEntry = parseCoachHabit('{"rounds":[],"habit":"NO_ENTRY"}');
assert(noEntry.ok && noEntry.habit === null, 'NO_ENTRY accepted');

const confounded = parseCoachHabit(
	JSON.stringify({
		rounds: [{ id: 'r1', change: 'a', observed: 'b', verdict: 'confounded' }],
		habit: { cue: 'x', habit: 'always rewrite the whole file', evidence: ['r1'], confidence: 'high' },
	})
);
assert(!confounded.ok, 'confounded-only habit rejected');

const okHabit = parseCoachHabit(
	JSON.stringify({
		rounds: [{ id: 'r1', change: 'a', observed: 'b', verdict: 'hurt' }],
		habit: {
			cue: 'oracle red after mass rewrite',
			habit: 'Prefer small edits over rewriting the whole file',
			evidence: ['r1'],
			confidence: 'medium',
		},
	})
);
assert(okHabit.ok && !!okHabit.habit, 'valid habit accepted');

// Probation lifecycle over 7 synthetic features / 2 habits.
let habits = emptyHabitsFile();
const features = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
const roundsByFeature: Record<string, { kept: boolean; feature: string; at: string }[]> = {};
for (const f of features) {
	roundsByFeature[f] = [
		{ kept: false, feature: f, at: `${f}-1` },
		{ kept: true, feature: f, at: `${f}-2` },
	];
}
// High undo baseline when habit1 enters.
const allRounds = features.flatMap(f => roundsByFeature[f]);
const added1 = addHabitOnProbation(
	habits,
	{
		cue: 'mass rewrite',
		habit: 'Prefer small edits',
		evidence: ['r1'],
		confidence: 'medium',
	},
	{ featureKey: 'f1@t', baselineUndoRate: 0.8 }
);
assert(!('error' in added1), 'habit1 added');
habits = added1 as typeof habits;

const added2 = addHabitOnProbation(
	habits,
	{
		cue: 'skip verify',
		habit: 'Run the oracle after each write',
		evidence: ['r2'],
		confidence: 'medium',
	},
	{ featureKey: 'f2@t', baselineUndoRate: 0.5 }
);
assert(!('error' in added2), 'habit2 added');
habits = added2 as typeof habits;

// Undo rate 0.5: below habit1 baseline (0.8) → kept; not below habit2 (0.5) → removed.
for (let i = 0; i < HABIT_PROBATION_FEATURES; i++) {
	const key = `f${i + 3}@t`;
	const mixed = [
		{ kept: false, feature: 'later', at: `${key}-1` },
		{ kept: true, feature: 'later', at: `${key}-2` },
	];
	habits = advanceHabitProbation(habits, mixed, key);
}
const h1 = habits.habits.find(h => h.cue === 'mass rewrite')!;
const h2 = habits.habits.find(h => h.cue === 'skip verify')!;
assert(h1.status === 'kept', 'habit1 kept after undo rate drop');
assert(h2.status === 'removed', 'habit2 removed without improvement');

const rendered = renderHowToWork([
	...Array.from({ length: 8 }, (_, i) => ({
		id: `h${i}`,
		cue: `cue${i}`,
		habit: `habit${i}`,
		evidence: [],
		confidence: 'medium',
		status: 'kept' as const,
		featureKey: `f${i}`,
		baselineUndoRate: 0.5,
		featuresSeen: 3,
		at: 't',
	})),
]);
const bullets = rendered.split('\n').filter(l => l.startsWith('- ('));
assert(bullets.length <= MAX_ACTIVE_HABITS, 'SKILL.md caps at 5 habits');
assert(undoRate(allRounds) > 0, 'synthetic undo rate computed');

console.log('experimentLoop ok');
