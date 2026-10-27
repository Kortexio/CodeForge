/**
 * Online hysteresis: chat-only, unrepaired leaks, cooldown via configHash, revert.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyOnlineHysteresis } from './profileHysteresis';
import { defaultModelProfile, saveModelProfile } from './modelProfile';
import { profileConfigHash } from './harnessFingerprint';
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

function makeRun(
	reason?: string,
	source: 'chat' | 'bench' = 'chat',
	configHash?: string
): RunTelemetryRecord {
	return {
		at: new Date().toISOString(),
		serverId,
		model,
		source,
		protocol: emptyProtocolCounters(),
		sampleCount: reason ? 1 : 0,
		sampleReasons: reason ? [reason] : [],
		...(configHash ? { configHash } : {}),
	};
}

function writeRollup(recent: RunTelemetryRecord[]): void {
	const rollup: ProtocolRollup = {
		serverId,
		model,
		updatedAt: new Date().toISOString(),
		runCount: recent.length,
		sums: emptyProtocolCounters(),
		recent,
	};
	fs.writeFileSync(path.join(dir, 'rollup.json'), JSON.stringify(rollup), 'utf8');
}

// Bench runs alone never flip.
const profileOff = defaultModelProfile(serverId, model);
profileOff.mutations.writeMaxContentLines = 0;
writeRollup(Array.from({ length: 12 }, () => makeRun('truncated_tool_json', 'bench')));
const rBench = applyOnlineHysteresis(profileOff);
assert(!rBench.changed, 'bench runs ignored');

// 12 chat trunc hits → write cap on
writeRollup(Array.from({ length: 12 }, () => makeRun('truncated_tool_json', 'chat')));
const r1 = applyOnlineHysteresis(profileOff);
assert(r1.changed && r1.profile.mutations.writeMaxContentLines === 180, 'cap turns on');

// 12 clean chat runs is not enough for off (needs full 50-run window)
const profileOn = defaultModelProfile(serverId, model);
profileOn.mutations.writeMaxContentLines = 180;
writeRollup(Array.from({ length: 12 }, () => makeRun(undefined, 'chat')));
const r2short = applyOnlineHysteresis(profileOn);
assert(!r2short.changed, 'cap stays on until 50 clean runs');

writeRollup(Array.from({ length: 50 }, () => makeRun(undefined, 'chat')));
const r2 = applyOnlineHysteresis(profileOn);
assert(r2.changed && r2.profile.mutations.writeMaxContentLines === 0, 'cap turns off');

writeRollup(Array.from({ length: 5 }, () => makeRun('truncated_tool_json', 'chat')));
const r3 = applyOnlineHysteresis(profileOff);
assert(!r3.changed, 'need 10 runs');

// Unrepaired leak only — repaired does not count
const profileTemp = defaultModelProfile(serverId, model);
profileTemp.sampling.toolThinking.temperature = 0.7;
writeRollup(
	Array.from({ length: 12 }, (_, i) =>
		makeRun(i < 2 ? 'leaked_param_repaired' : undefined, 'chat')
	)
);
const rRepaired = applyOnlineHysteresis(profileTemp);
assert(!rRepaired.changed, 'repaired leaks do not lower temp');

writeRollup(
	Array.from({ length: 12 }, (_, i) =>
		makeRun(i < 2 ? 'leaked_param_conflict' : undefined, 'chat')
	)
);
const r4 = applyOnlineHysteresis(profileTemp);
assert(r4.changed && r4.profile.sampling.toolThinking.temperature === 0.6, 'temp down on conflict');

// Four loads with the NEW configHash (after flip) should not flip again until 10 matching runs.
const after = r4.profile;
const newHash = profileConfigHash(after, 0);
writeRollup(
	Array.from({ length: 4 }, (_, i) =>
		makeRun(i < 2 ? 'leaked_param_conflict' : undefined, 'chat', newHash)
	)
);
const rAgain = applyOnlineHysteresis(after);
assert(!rAgain.changed, 'cooldown: need 10 runs under the new configHash');

// toolRounds on → toolReasoning slice
const profileThink = defaultModelProfile(serverId, model);
profileThink.thinking.toolRounds = true;
profileThink.sampling.toolReasoning.temperature = 0.7;
profileThink.sampling.toolThinking.temperature = 0.7;
writeRollup(
	Array.from({ length: 12 }, (_, i) =>
		makeRun(i < 2 ? 'leaked_param_conflict' : undefined, 'chat')
	)
);
const rThink = applyOnlineHysteresis(profileThink);
assert(
	rThink.changed &&
		rThink.profile.sampling.toolReasoning.temperature === 0.6 &&
		rThink.profile.sampling.toolThinking.temperature === 0.7,
	'thinking-on lowers toolReasoning only'
);

saveModelProfile(profileOn, path.join(dir, 'profile.json'));
delete process.env.CODEFORGE_MODEL_PROFILE_HOME;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('profileHysteresis.selftest: ok');
