/**
 * Protocol aggregator + rollup flush.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createProtocolAggregator,
	flushRunTelemetry,
	loadModelRollup,
	truncatedToolJsonRate,
} from './protocolTelemetry';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-proto-'));
const profileDir = path.join(tmp, 'srv', 'model');

const agg = createProtocolAggregator();
agg.observe({ kind: 'tool', label: 'edit' }); // ignored
agg.observe({ kind: 'protocol', label: 'nativeToolCalls', detail: '3' });
agg.observe({ kind: 'protocol', label: 'badArgs', detail: '1' });
agg.observe({ kind: 'protocol', label: 'systemChars', detail: '2900' });
agg.observe({
	kind: 'protocol',
	label: 'sample',
	detail: JSON.stringify({ reason: 'truncated_tool_json', tool: 'write' }),
});

const snap = agg.snapshot();
assert(snap.protocol.nativeToolCalls === 3, 'native bump');
assert(snap.protocol.badArgs === 1, 'badArgs bump');
assert(snap.protocol.systemChars === 2900, 'systemChars assign');
assert(snap.sampleCount === 1 && snap.samples[0]?.reason === 'truncated_tool_json', 'sample');

const rec = flushRunTelemetry({
	serverId: 'srv',
	model: 'model',
	source: 'bench',
	loopExit: 'done',
	elapsedMs: 1000,
	aggregator: agg,
	profileDir,
});
assert(rec.sampleReasons[0] === 'truncated_tool_json', 'reasons');
assert(fs.existsSync(path.join(profileDir, 'runs.jsonl')), 'runs.jsonl');
const rollup = loadModelRollup('srv', 'model', profileDir);
assert(!!rollup && rollup.runCount === 1, 'rollup count');
assert(rollup!.sums.nativeToolCalls === 3, 'rollup sums');
assert(truncatedToolJsonRate(rollup!) === 1, 'trunc rate');

flushRunTelemetry({
	serverId: 'srv',
	model: 'model',
	source: 'chat',
	aggregator: createProtocolAggregator(),
	profileDir,
});
const rollup2 = loadModelRollup('srv', 'model', profileDir)!;
assert(rollup2.runCount === 2 && rollup2.recent.length === 2, 'second flush');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('protocolTelemetry.selftest: ok');
