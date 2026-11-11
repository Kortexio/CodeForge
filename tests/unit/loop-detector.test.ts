import {
	createLoopDetector,
	hashResult,
	isEffectfulToolName,
	isExploreToolName,
	globFamilyKey,
	listFamilyKey,
	readFamilyKey,
	searchFamilyKey,
	webSearchFamilyKey,
	DIAGNOSTICS_WORKSPACE_FAMILY,
} from '../../extensions/codeforge/src/agent/loopDetector';

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

	it('many distinct reads do not stop the loop (no explore-step cap)', () => {
		const d = createLoopDetector();
		for (let i = 0; i < 40; i++) {
			d.recordCall(`read:file-${i}`, `hash-${i}`);
			d.endStep();
		}
		expect(d.shouldStop()).toBe(false);
		expect(d.getConsecutiveIdenticalSteps()).toBe(0);
	});

	it('isExploreToolName covers read/list/glob but not edit/shell', () => {
		expect(isExploreToolName('read')).toBe(true);
		expect(isExploreToolName('list')).toBe(true);
		expect(isExploreToolName('glob')).toBe(true);
		expect(isExploreToolName('edit')).toBe(false);
		expect(isExploreToolName('shell')).toBe(false);
		expect(isExploreToolName('browser_navigate')).toBe(false);
	});

	it('isEffectfulToolName is edit/shell/browser — not skill', () => {
		expect(isEffectfulToolName('edit')).toBe(true);
		expect(isEffectfulToolName('shell')).toBe(true);
		expect(isEffectfulToolName('browser_snapshot')).toBe(true);
		expect(isEffectfulToolName('skill')).toBe(false);
		expect(isEffectfulToolName('read')).toBe(false);
		expect(isEffectfulToolName('await_shell')).toBe(false);
	});

	it('unchangedStreak >= 3 stops', () => {
		const d = createLoopDetector();
		d.setUnchangedStreak(3);
		expect(d.getUnchangedStreak()).toBe(3);
		expect(d.shouldStop()).toBe(true);
		expect(d.cause()).toMatch(/UNCHANGED/i);
	});

	it('globFamilyKey is scope + exact pattern', () => {
		expect(globFamilyKey('**/*.csproj', 'src')).toBe('glob:src|**/*.csproj');
		expect(globFamilyKey('**/*.CSProj')).toBe('glob:.|**/*.csproj');
	});

	it('listFamilyKey maps failed children onto the parent folder', () => {
		expect(listFamilyKey('.vscode', false)).toBe('list:.vscode');
		expect(listFamilyKey('.vscode/launch.json', true)).toBe('list:.vscode');
		expect(listFamilyKey('.vscode/launch', true)).toBe('list:.vscode');
		expect(listFamilyKey('src/pricing', false)).toBe('list:src/pricing');
	});

	it('stops after 3 consecutive list-only steps on the same folder family', () => {
		const d = createLoopDetector();
		d.recordCall('list:.vscode', hashResult('settings.json'), { listFamily: '.vscode' });
		d.endStep();
		d.recordCall('list:.vscode/launch', hashResult('ENOENT launch'), { listFamily: '.vscode' });
		d.endStep();
		expect(d.shouldStop()).toBe(false);
		d.recordCall('list:.vscode/launch.json', hashResult('ENOENT json'), { listFamily: '.vscode' });
		d.endStep();
		expect(d.getConsecutiveListFamilySteps()).toBe(3);
		expect(d.shouldStop()).toBe(true);
		expect(d.stallKind()).toBe('list-family');
		expect(d.cause()).toMatch(/same folder/i);
	});

	it('does not stop when each list is a different successful subfolder', () => {
		const d = createLoopDetector();
		d.recordCall('list:src', hashResult('a'), { listFamily: 'src' });
		d.endStep();
		d.recordCall('list:src/pricing', hashResult('b'), { listFamily: 'src/pricing' });
		d.endStep();
		d.recordCall('list:src/cart', hashResult('c'), { listFamily: 'src/cart' });
		d.endStep();
		expect(d.shouldStop()).toBe(false);
	});

	it('searchFamilyKey groups launch variants and not unrelated needles', () => {
		expect(searchFamilyKey('launch')).toBe(searchFamilyKey('launch.json'));
		expect(searchFamilyKey('\\blaunch')).toBe(searchFamilyKey('launch'));
		expect(searchFamilyKey('applyCoupon')).not.toBe(searchFamilyKey('WELCOME10'));
	});

	it('stops after 3 consecutive search-family steps on the same needle', () => {
		const d = createLoopDetector();
		const fam = searchFamilyKey('launch');
		d.recordCall('search:launch', hashResult('0'), { family: fam });
		d.endStep();
		d.recordCall('search:launch.json', hashResult('0b'), { family: searchFamilyKey('launch.json') });
		d.endStep();
		expect(d.shouldStop()).toBe(false);
		d.recordCall('search:blaunch', hashResult('0c'), { family: searchFamilyKey('\\blaunch') });
		d.endStep();
		expect(d.getConsecutiveListFamilySteps()).toBe(3);
		expect(d.shouldStop()).toBe(true);
		expect(d.stallKind()).toBe('search-family');
		expect(d.cause()).toMatch(/same needle/i);
	});

	it('stops after 3 consecutive glob-family steps on the same pattern', () => {
		const d = createLoopDetector();
		const fam = globFamilyKey('**/*.csproj');
		d.recordCall('glob:a', hashResult('0'), { family: fam });
		d.endStep();
		d.recordCall('glob:b', hashResult('0b'), { family: fam });
		d.endStep();
		expect(d.shouldStop()).toBe(false);
		d.recordCall('glob:c', hashResult('0c'), { family: fam });
		d.endStep();
		expect(d.shouldStop()).toBe(true);
		expect(d.stallKind()).toBe('glob-family');
		expect(d.cause()).toMatch(/same pattern/i);
	});

	it('does not search-family-stall across unrelated needles', () => {
		const d = createLoopDetector();
		d.recordCall('s1', 'a', { family: searchFamilyKey('applyCoupon') });
		d.endStep();
		d.recordCall('s2', 'b', { family: searchFamilyKey('WELCOME10') });
		d.endStep();
		d.recordCall('s3', 'c', { family: searchFamilyKey('applyCoupon') });
		d.endStep();
		expect(d.shouldStop()).toBe(false);
	});

	it('read-family stalls on the same path key', () => {
		const d = createLoopDetector();
		const fam = readFamilyKey('src/a.ts');
		d.recordCall('read:a:1', 'x', { family: fam });
		d.endStep();
		d.recordCall('read:a:2', 'y', { family: fam });
		d.endStep();
		d.recordCall('read:a:3', 'z', { family: fam });
		d.endStep();
		expect(d.stallKind()).toBe('read-family');
		expect(d.shouldStop()).toBe(true);
	});

	it('web-search and diagnostics families stall', () => {
		const d = createLoopDetector();
		const fam = webSearchFamilyKey('zuora billing api');
		d.recordCall('web:1', '0', { family: fam });
		d.endStep();
		d.recordCall('web:2', '0b', { family: fam });
		d.endStep();
		d.recordCall('web:3', '0c', { family: fam });
		d.endStep();
		expect(d.stallKind()).toBe('web-search-family');

		const d2 = createLoopDetector();
		d2.recordCall('diag:1', 'none', { family: DIAGNOSTICS_WORKSPACE_FAMILY });
		d2.endStep();
		d2.recordCall('diag:2', 'none2', { family: DIAGNOSTICS_WORKSPACE_FAMILY });
		d2.endStep();
		d2.recordCall('diag:3', 'none3', { family: DIAGNOSTICS_WORKSPACE_FAMILY });
		d2.endStep();
		expect(d2.stallKind()).toBe('diagnostics-family');
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
