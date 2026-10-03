/**
 * Unit checks for the experiment loop helpers (no test runner — run via npx tsx).
 */
import {
	CHECKS_LOCK_REL,
	collectLockablePaths,
	denyExperimentMutation,
	formatChecksLock,
	formatRoundResultLine,
	HOW_TO_WORK_REL,
	isLockableCheckPath,
	isLockedScorePath,
	lockedScorePaths,
	ORACLE_JSON_REL,
	parseChecksLock,
	parseRoundResults,
	planMayWritePath,
	shellMentionsLockedPath,
	shouldRunCoach,
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
	})?.includes('coach'),
	'coach cannot write app code'
);
assert(
	denyExperimentMutation('write', { path: HOW_TO_WORK_REL }, {
		experimentActive: true,
		coachMode: true,
		locked,
	}) === null,
	'coach may write how-to-work'
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

console.log('experimentLoop ok');
