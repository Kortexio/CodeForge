/**
 * ModelProfile defaults, merge, load, strong calibration.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	applyCalibrationFromStats,
	applyStrongCalibration,
	classifyCalibration,
	defaultModelProfile,
	loadModelProfile,
	mergeModelProfile,
	saveModelProfile,
} from './modelProfile';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const d = defaultModelProfile('s', 'm');
assert(d.sampling.toolThinking.presence_penalty === 0, 'pp 0');
assert(d.mutations.writeMaxContentLines === 180, 'write cap 180');
assert(d.finish.specSelfCheckEnabled === true, 'spec check on');
assert(d.orchestrator.itemMaxSteps === 25, 'orch steps');

const merged = mergeModelProfile(d, {
	mutations: { writeMaxContentLines: 0, largeFileExistingLines: 60, enforceMassRewriteGate: false },
});
assert(merged.mutations.writeMaxContentLines === 0, 'merge override');
assert(merged.sampling.toolThinking.temperature === 0.7, 'merge keeps rest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-prof-'));
const fp = path.join(tmp, 'profile.json');
saveModelProfile(merged, fp);
const loaded = loadModelProfile('s', 'm', {
	filePath: fp,
	createIfMissing: false,
	applyHysteresis: false,
});
assert(loaded.mutations.writeMaxContentLines === 0, 'load disk');

const strong = applyStrongCalibration(defaultModelProfile('s', 'strong'), {
	passRate: 1,
	badArgsRate: 0.01,
	lengthExits: 0,
	totalRuns: 12,
});
assert(strong.mutations.writeMaxContentLines === 0, 'strong no write cap');
assert(strong.finish.specSelfCheckEnabled === false, 'strong no spec check');
assert(strong.prompt.forcedWeakSkill === false, 'strong no weak skill');

const strongBorder = applyStrongCalibration(defaultModelProfile('s', 'strong2'), {
	passRate: 0.5,
	badArgsRate: 0.03,
	lengthExits: 0,
	totalRuns: 12,
});
assert(strongBorder.mutations.writeMaxContentLines === 0, '0.03 clears write cap');
assert(strongBorder.prompt.forcedWeakSkill === false, '0.03 clears weak skill');
assert(strongBorder.finish.specSelfCheckEnabled === true, 'spec check needs 11/12');

assert(classifyCalibration({ passRate: 0.5, badArgsRate: 0.03, lengthExits: 0, totalRuns: 12 }) === 'strong', 'class strong');
assert(classifyCalibration({ passRate: 0.5, badArgsRate: 0.2, lengthExits: 0, totalRuns: 12 }) === 'weak', 'class weak');
assert(
	classifyCalibration({
		passRate: 0.9,
		badArgsRate: 0.01,
		lengthExits: 0,
		totalRuns: 12,
		nativeToolCalls: 0,
	}) === 'weak',
	'no native → weak'
);
assert(
	classifyCalibration({
		passRate: 0.4,
		badArgsRate: 0.01,
		lengthExits: 0,
		totalRuns: 12,
		nativeToolCalls: 10,
	}) === 'weak',
	'low passRate → weak'
);

const autoWeak = applyCalibrationFromStats(defaultModelProfile('s', 'auto'), {
	passRate: 0.4,
	badArgsRate: 0.2,
	lengthExits: 0,
	totalRuns: 12,
});
assert(autoWeak.classification === 'weak', 'auto weak');
assert(autoWeak.profile.mutations.writeMaxContentLines === 180, 'auto weak cap');

const autoStrong = applyCalibrationFromStats(defaultModelProfile('s', 'auto2'), {
	passRate: 0.5,
	badArgsRate: 0.03,
	lengthExits: 0,
	totalRuns: 12,
});
assert(autoStrong.classification === 'strong', 'auto strong');
assert(autoStrong.profile.mutations.writeMaxContentLines === 0, 'auto strong no cap');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('modelProfile.selftest: ok');
