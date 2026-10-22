/**
 * Locate bench script + basic calibrate guards.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findBenchScript, calibrateUnavailableMessage } from './modelProfileCalibrate';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const extRoot = path.resolve(__dirname, '..', '..');
const packaged = path.join(extRoot, 'resources', 'calibrate-bench', 'bench.mjs');
const repoBench = path.resolve(extRoot, '..', '..', 'benchmarks', 'bench.mjs');
const viaExt = findBenchScript(extRoot);
assert(!!viaExt || fs.existsSync(repoBench) || fs.existsSync(packaged), 'bench available');
if (viaExt) {
	assert(fs.existsSync(viaExt), 'findBenchScript path exists');
	assert(/bench\.mjs$/i.test(viaExt), 'points at bench.mjs');
}
assert(/missing|rebuild/i.test(calibrateUnavailableMessage()), 'unavailable message');

console.log('modelProfileCalibrate.selftest: ok');
