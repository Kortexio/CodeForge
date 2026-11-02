/**
 * Plano B: steering is consumed mid-turn; follow-up stays until the agent would stop.
 * Run: npx tsc -p . && node out/agent/steeringQueue.selftest.js
 */
import * as assert from 'node:assert/strict';
import { batchRunsInParallel, batchTerminates, finishAgentTurn } from './agentLoopHooks';
import { SteeringQueue } from './steeringQueue';

function testQueueModes(): void {
	const fresh = new SteeringQueue();
	fresh.push('steer', 'look at foo.ts', 's1');
	fresh.push('followup', 'now add tests', 'f1');
	fresh.push('steer', 'also bar.ts', 's2');
	assert.deepEqual(fresh.drainSteering(), ['look at foo.ts', 'also bar.ts']);
	assert.equal(fresh.items.length, 1);
	assert.equal(fresh.shiftFollowUp()?.text, 'now add tests');
	assert.equal(fresh.shiftFollowUp(), undefined);
}

function testClear(): void {
	const q = new SteeringQueue();
	q.push('steer', 'a', '1');
	q.push('followup', 'b', '2');
	q.remove('1');
	assert.equal(q.items.length, 1);
	q.clear();
	assert.equal(q.items.length, 0);
}

function testFinishAndParallel(): void {
	assert.equal(finishAgentTurn({ refuseDiag: true }), 'continue');
	assert.equal(finishAgentTurn({ refuseDiag: false }), 'end');
	assert.equal(batchRunsInParallel(['read', 'list'], () => false), true);
	assert.equal(batchRunsInParallel(['read', 'edit'], () => false), false);
	assert.equal(batchRunsInParallel(['read'], () => true), false);
	assert.equal(batchTerminates(['update_status']), true);
	assert.equal(batchTerminates(['update_status', 'read']), false);
}

async function run(): Promise<void> {
	testQueueModes();
	testClear();
	testFinishAndParallel();
	console.log('steeringQueue.selftest: ok');
}

if (require.main === module) {
	run().catch(err => {
		console.error(err);
		process.exit(1);
	});
}

export { run };
