/**
 * ModelProfile defaults, merge, load, strong calibration.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	applyCalibrationFromStats,
	applyStrongCalibration,
	candidateArmWins,
	candidateToolTransport,
	classifyCalibration,
	defaultModelProfile,
	loadModelProfile,
	mergeModelProfile,
	resolveProfileForRun,
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
assert(d.thinking.toolRounds === false, 'tool-round thinking off by default');

const legacyFp = path.join(tmp, 'legacy.json');
const legacy = structuredClone(d) as Partial<typeof d>;
delete legacy.thinking;
fs.writeFileSync(legacyFp, JSON.stringify(legacy), 'utf8');
const legacyLoaded = loadModelProfile('s', 'm', {
	filePath: legacyFp,
	createIfMissing: false,
	applyHysteresis: false,
});
assert(legacyLoaded.thinking.toolRounds === false, 'profile written before the knob gets the default');

const thinkFp = path.join(tmp, 'think.json');
saveModelProfile(mergeModelProfile(d, { thinking: { ...d.thinking, toolRounds: true } }), thinkFp);
const thinkLoaded = loadModelProfile('s', 'm', {
	filePath: thinkFp,
	createIfMissing: false,
	applyHysteresis: false,
});
assert(thinkLoaded.thinking.toolRounds === true, 'toolRounds knob loads from disk');
assert(
	applyCalibrationFromStats(thinkLoaded, { passRate: 0.4, badArgsRate: 0.2, lengthExits: 0, totalRuns: 4 })
		.profile.thinking.toolRounds === true,
	'weak calibration keeps the thinking knob'
);

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

assert(d.thinking.maxTokens > d.completion.mutatingMaxTokens, 'thinking cap leaves room above the write cap');
assert(d.thinking.supported === undefined, 'support is unmeasured until calibrate');

assert(
	d.sampling.toolReasoning.temperature === d.sampling.toolThinking.temperature &&
		d.sampling.toolReasoning.top_p === d.sampling.toolThinking.top_p,
	'thinking tool rounds default to the tool sampling (one variable at a time)'
);
const withServer = resolveProfileForRun('s', 'srv-samp', { temperature: 0.4 }, {
	filePath: path.join(tmp, 'srv-samp.json'),
	createIfMissing: false,
	applyHysteresis: false,
});
assert(withServer.sampling.toolReasoning.temperature === 0.4, 'server sampling override reaches toolReasoning');

const arm = (passes: number, runs: number, meanScore: number) => ({ passes, runs, meanScore });
assert(candidateArmWins(arm(8, 12, 85), arm(10, 12, 80)), 'more passes wins');
assert(!candidateArmWins(arm(10, 12, 80), arm(8, 12, 95)), 'fewer passes loses despite a higher mean');
assert(
	!candidateArmWins(arm(9, 12, 82), arm(9, 12, 88)),
	'same pass rate never wins on mean alone — aggregate-only path requires a clear pass-rate gain'
);
assert(!candidateArmWins(arm(9, 12, 88), arm(9, 12, 88)), 'tie keeps the baseline');
assert(!candidateArmWins(arm(9, 12, 88), arm(0, 0, 0)), 'empty candidate arm never wins');
// 2026-10-25 calibrate: thinking off 10/12 · 98.5 vs on 9/12 · 88.8
assert(!candidateArmWins(arm(10, 12, 98.5), arm(9, 12, 88.8)), 'measured thinking-on arm loses');

const transport = (over: Partial<Parameters<typeof candidateToolTransport>[0]>) =>
	candidateToolTransport({
		reps: 3,
		current: 'native',
		classification: 'weak',
		badArgsRate: 0,
		refusalRate: 0,
		...over,
	});
assert(transport({ reps: 1, badArgsRate: 0.356 }) === undefined, 'one rep never proposes (the 2026-10-25 CS3 cell)');
assert(transport({ badArgsRate: 0.2 }) === 'text', 'leaky args propose text');
assert(transport({ badArgsRate: 0.01, refusalRate: 0.15 }) === 'text', 'many refusals propose text');
assert(transport({ badArgsRate: 0.2, current: 'text' }) === undefined, 'no proposal when already on text');
assert(
	transport({ classification: 'strong', badArgsRate: 0.01, current: 'text' }) === 'native',
	'clean strong on text proposes native'
);
assert(transport({ classification: 'strong', badArgsRate: 0.01 }) === undefined, 'clean strong on native: nothing to try');
assert(transport({ badArgsRate: 0.06 }) === undefined, 'in-between proposes nothing');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('modelProfile.selftest: ok');
