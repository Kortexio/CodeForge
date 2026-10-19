import { createLoopDetector, hashResult } from '../../extensions/codeforge/src/agent/loopDetector';

describe('loopDetector', () => {
	it('hashResult is stable and differs for different text', () => {
		expect(hashResult('abc')).toBe(hashResult('abc'));
		expect(hashResult('abc')).not.toBe(hashResult('abd'));
	});

	it('recordCall notes identical fingerprint+result and names the first step', () => {
		const d = createLoopDetector();
		expect(d.recordCall('read:a', hashResult('body')).note).toBeUndefined();
		d.endStep();
		const again = d.recordCall('read:a', hashResult('body'));
		expect(again.note).toBe('(identical call and result to step 1)');
	});

	it('shouldStop after 3 consecutive steps of all-identical repeats', () => {
		const d = createLoopDetector();
		d.recordCall('read:a', 'h1');
		d.endStep();
		expect(d.shouldStop()).toBe(false);

		for (let i = 0; i < 3; i++) {
			d.recordCall('read:a', 'h1');
			d.endStep();
		}
		expect(d.getConsecutiveIdenticalSteps()).toBe(3);
		expect(d.shouldStop()).toBe(true);
		expect(d.cause()).toMatch(/identical tool calls/i);
	});

	it('resets identical streak when a step has a fresh call', () => {
		const d = createLoopDetector();
		d.recordCall('read:a', 'h1');
		d.endStep();
		d.recordCall('read:a', 'h1');
		d.endStep();
		expect(d.getConsecutiveIdenticalSteps()).toBe(1);
		d.recordCall('read:b', 'h2');
		d.endStep();
		expect(d.getConsecutiveIdenticalSteps()).toBe(0);
	});

	it('exploreOnlySteps >= 20 stops', () => {
		const d = createLoopDetector();
		d.setExploreOnlySteps(20);
		expect(d.getExploreOnlySteps()).toBe(20);
		expect(d.shouldStop()).toBe(true);
		expect(d.cause()).toMatch(/explore-only/i);
	});

	it('unchangedStreak >= 3 stops', () => {
		const d = createLoopDetector();
		d.setUnchangedStreak(3);
		expect(d.getUnchangedStreak()).toBe(3);
		expect(d.shouldStop()).toBe(true);
		expect(d.cause()).toMatch(/UNCHANGED/i);
	});

	it('a mixed step (repeat + fresh) does not count as identical', () => {
		const d = createLoopDetector();
		d.recordCall('a', '1');
		d.endStep();
		d.recordCall('a', '1');
		d.recordCall('b', '2');
		d.endStep();
		expect(d.getConsecutiveIdenticalSteps()).toBe(0);
	});
});
