/**
 * Configurable stall threshold must actually gate shouldStop/cause — not a no-op knob.
 */
import {
	createLoopDetector,
	globFamilyKey,
	hashResult,
	listFamilyKey,
	searchFamilyKey,
} from './loopDetector';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function repeatStep(det: ReturnType<typeof createLoopDetector>, fp: string, result: string): void {
	det.recordCall(fp, hashResult(result));
	det.endStep();
}

// Default threshold (3): the first call seeds the fingerprint; it takes 3 more
// identical steps (consecutiveIdenticalSteps counts repeat-only steps) to trip.
{
	const det = createLoopDetector();
	repeatStep(det, 'read:a', 'A'); // seeds the fingerprint, not a repeat
	assert(!det.shouldStop(), 'first occurrence is not a repeat');
	repeatStep(det, 'read:a', 'A'); // consecutiveIdenticalSteps=1
	repeatStep(det, 'read:a', 'A'); // consecutiveIdenticalSteps=2
	assert(!det.shouldStop(), 'two repeats do not trip the default threshold yet');
	repeatStep(det, 'read:a', 'A'); // consecutiveIdenticalSteps=3
	assert(det.shouldStop(), 'default threshold 3 trips after 3 identical repeat steps');
	assert(/3 consecutive steps/.test(det.cause()), 'default cause mentions 3');
}

// Loosened threshold (5): the same repeat streak that trips the default must NOT stop yet.
{
	const det = createLoopDetector({ stallThreshold: 5 });
	repeatStep(det, 'read:a', 'A'); // seed
	repeatStep(det, 'read:a', 'A'); // 1
	repeatStep(det, 'read:a', 'A'); // 2
	repeatStep(det, 'read:a', 'A'); // 3 — would trip the default
	assert(!det.shouldStop(), 'threshold 5 does not stop at 3 identical repeat steps');
	repeatStep(det, 'read:a', 'A'); // 4
	repeatStep(det, 'read:a', 'A'); // 5
	assert(det.shouldStop(), 'threshold 5 stops once 5 identical repeat steps are reached');
	assert(/5 consecutive steps/.test(det.cause()), 'cause reports the configured threshold');
}

// A non-repeat call resets the streak regardless of threshold.
{
	const det = createLoopDetector({ stallThreshold: 5 });
	repeatStep(det, 'read:a', 'A'); // seed
	repeatStep(det, 'read:a', 'A'); // 1
	repeatStep(det, 'read:a', 'A'); // 2
	repeatStep(det, 'edit:b', 'B'); // new fingerprint — resets the streak to 0
	repeatStep(det, 'read:a', 'A'); // 1
	repeatStep(det, 'read:a', 'A'); // 2
	assert(!det.shouldStop(), 'streak reset by a non-repeat step');
}

// A tripped identical streak can be cleared so one recovery round is possible.
{
	const det = createLoopDetector();
	repeatStep(det, 'read:a', 'A');
	repeatStep(det, 'read:a', 'A');
	repeatStep(det, 'read:a', 'A');
	repeatStep(det, 'read:a', 'A');
	assert(det.shouldStop() && det.stallKind() === 'identical', 'identical stall kind');
	det.resetIdenticalStreak();
	assert(!det.shouldStop(), 'reset clears the identical stall');
	assert(det.stallKind() === null, 'no stall kind after reset');
}

assert(listFamilyKey('.vscode', false) === 'list:.vscode', 'ok list of a dir is itself');
assert(
	listFamilyKey('.vscode/launch.json', true) === 'list:.vscode',
	'failed child lists under the parent'
);
assert(
	listFamilyKey('.vscode/launch', true) === 'list:.vscode',
	'failed extensionless child lists under the parent'
);
assert(
	listFamilyKey('src/pricing', false) === 'list:src/pricing',
	'ok list of a subfolder is not the parent'
);
assert(
	globFamilyKey('**/*.csproj', 'src') === 'glob:src|**/*.csproj',
	'glob family is scope + exact pattern'
);
assert(
	searchFamilyKey('launch') === searchFamilyKey('launch.json'),
	'search family groups launch variants'
);
assert(
	searchFamilyKey('applyCoupon') !== searchFamilyKey('WELCOME10'),
	'search family keeps unrelated needles apart'
);

{
	const det = createLoopDetector();
	const fam = searchFamilyKey('launch');
	det.recordCall('search:a', hashResult('0'), { family: fam });
	det.endStep();
	det.recordCall('search:b', hashResult('0b'), { family: searchFamilyKey('launch.json') });
	det.endStep();
	assert(!det.shouldStop(), 'two search-family steps do not trip yet');
	det.recordCall('search:c', hashResult('0c'), { family: searchFamilyKey('\\blaunch') });
	det.endStep();
	assert(det.shouldStop(), 'three search-family steps trip');
	assert(det.stallKind() === 'search-family', 'search-family stall kind');
}

{
	const det = createLoopDetector();
	det.recordCall('list:.vscode', hashResult('settings.json'), { listFamily: '.vscode' });
	det.endStep();
	det.recordCall('list:.vscode/launch', hashResult('ENOENT launch'), { listFamily: '.vscode' });
	det.endStep();
	assert(!det.shouldStop(), 'two list-family steps do not trip yet');
	det.recordCall('list:.vscode/launch.json', hashResult('ENOENT json'), { listFamily: '.vscode' });
	det.endStep();
	assert(det.shouldStop(), 'three list-family steps on the same folder trip');
	assert(det.stallKind() === 'list-family', 'list-family stall kind');
	assert(/same folder/.test(det.cause()), 'list-family cause names the folder');
	det.resetIdenticalStreak();
	assert(!det.shouldStop(), 'reset clears list-family stall');
}

{
	const det = createLoopDetector();
	det.recordCall('list:src', hashResult('src kids'), { listFamily: 'src' });
	det.endStep();
	det.recordCall('list:src/pricing', hashResult('pricing kids'), { listFamily: 'src/pricing' });
	det.endStep();
	det.recordCall('list:src/cart', hashResult('cart kids'), { listFamily: 'src/cart' });
	det.endStep();
	assert(!det.shouldStop(), 'listing distinct subfolders is not a list-family stall');
}

{
	const det = createLoopDetector();
	det.recordCall('list:.vscode', hashResult('a'), { listFamily: '.vscode' });
	det.endStep();
	det.recordCall('read:settings', hashResult('json'));
	det.endStep();
	det.recordCall('list:.vscode', hashResult('a'), { listFamily: '.vscode' });
	det.endStep();
	assert(det.getConsecutiveListFamilySteps() === 1, 'a non-list step resets the list-family streak');
	assert(!det.shouldStop(), 'reset list-family streak does not stop');
}

console.log('loopDetector.selftest: ok');
