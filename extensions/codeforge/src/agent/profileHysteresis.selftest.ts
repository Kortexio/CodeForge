/**
 * Online hysteresis thresholds.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyOnlineHysteresis } from './profileHysteresis';
import { defaultModelProfile, saveModelProfile } from './modelProfile';
import type { ProtocolRollup, RunTelemetryRecord } from './protocolTelemetry';
import { emptyProtocolCounters } from './protocolTelemetry';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hyst-'));
process.env.CODEFORGE_MODEL_PROFILE_HOME = tmp;

const serverId = 'srv';
const model = 'mdl';
const dir = path.join(tmp, 'ai', 'model-profiles', serverId, model);
fs.mkdirSync(dir, { recursive: true });

function makeRun(reason?: string): RunTelemetryRecord {
	return {
		at: new Date().toISOString(),
		serverId,
		model,
		source: 'bench',
		protocol: emptyProtocolCounters(),
		sampleCount: reason ? 1 : 0,
		sampleReasons: reason ? [reason] : [],
	};
}

// 12 trunc hits of 12 → rate 1 → turn write cap on from 0
const profileOff = defaultModelProfile(serverId, model);
profileOff.mutations.writeMaxContentLines = 0;
const rollupOn: ProtocolRollup = {
	serverId,
	model,
	updatedAt: new Date().toISOString(),
	runCount: 12,
	sums: emptyProtocolCounters(),
	recent: Array.from({ length: 12 }, () => makeRun('truncated_tool_json')),
};
fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify(rollupOn), 'utf8');
const r1 = applyOnlineHysteresis(profileOff);
assert(r1.changed && r1.profile.mutations.writeMaxContentLines === 180, 'cap turns on');

// 12 clean runs is not enough for off (needs full 50-run window)
const profileOn = defaultModelProfile(serverId, model);
profileOn.mutations.writeMaxContentLines = 180;
const rollupOffShort: ProtocolRollup = {
	...rollupOn,
	recent: Array.from({ length: 12 }, () => makeRun()),
};
fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify(rollupOffShort), 'utf8');
const r2short = applyOnlineHysteresis(profileOn);
assert(!r2short.changed, 'cap stays on until 50 clean runs');

// 50 clean runs → rate 0 → turn cap off
const rollupOff: ProtocolRollup = {
	...rollupOn,
	runCount: 50,
	recent: Array.from({ length: 50 }, () => makeRun()),
};
fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify(rollupOff), 'utf8');
const r2 = applyOnlineHysteresis(profileOn);
assert(r2.changed && r2.profile.mutations.writeMaxContentLines === 0, 'cap turns off');

// fewer than 10 runs → no change
const few: ProtocolRollup = {
	...rollupOn,
	recent: Array.from({ length: 5 }, () => makeRun('truncated_tool_json')),
};
fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify(few), 'utf8');
const r3 = applyOnlineHysteresis(profileOff);
assert(!r3.changed, 'need 10 runs');

// leak rate ≥ 0.08 → toolThinking.temperature −0.1 (floor 0.3)
const profileTemp = defaultModelProfile(serverId, model);
profileTemp.sampling.toolThinking.temperature = 0.7;
const leakRuns = Array.from({ length: 12 }, (_, i) =>
	makeRun(i < 2 ? 'leaked_param' : undefined)
); // 2/12 ≈ 0.167
const rollupLeak: ProtocolRollup = {
	...rollupOn,
	recent: leakRuns,
};
fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify(rollupLeak), 'utf8');
const r4 = applyOnlineHysteresis(profileTemp);
assert(r4.changed && r4.profile.sampling.toolThinking.temperature === 0.6, 'temp down');

const profileFloor = defaultModelProfile(serverId, model);
profileFloor.sampling.toolThinking.temperature = 0.35;
const r5 = applyOnlineHysteresis(profileFloor);
assert(r5.changed && r5.profile.sampling.toolThinking.temperature === 0.3, 'temp floor 0.3');

saveModelProfile(profileOn, path.join(dir, 'profile.json'));
delete process.env.CODEFORGE_MODEL_PROFILE_HOME;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('profileHysteresis.selftest: ok');
