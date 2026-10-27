/**
 * Configurable stall threshold must actually gate shouldStop/cause — not a no-op knob.
 */
import { createLoopDetector, hashResult } from './loopDetector';

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

console.log('loopDetector.selftest: ok');
