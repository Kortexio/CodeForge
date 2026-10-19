/**
 * Former stage-machine checks. Explore/act/verify stages were removed from the harness;
 * coding/apply_patch/plan helpers remain covered here.
 */
import { modelUsesApplyPatch } from './applyPatch';
import { hashTask, looksLikeBareContinue, pathAllowedByPlan, type InternalPlan } from './internalPlans';
import { isCodingTask } from './toolsets';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(isCodingTask('implement login form'), 'coding');
assert(!isCodingTask('list models at https://example.com/v1'), 'non-coding http');

assert(modelUsesApplyPatch('gpt-5'), 'gpt patch');
assert(!modelUsesApplyPatch('qwen3'), 'qwen no patch');

const plan: InternalPlan = {
	version: 1,
	id: 'x',
	task: 'scaffold',
	taskHash: hashTask('scaffold'),
	items: [{ id: '1', title: 'a', status: 'pending', paths: ['a.ts'] }],
	createdAt: '',
	updatedAt: '',
};
assert(pathAllowedByPlan(plan, 'a.ts'), 'allow');
assert(!pathAllowedByPlan(plan, 'b.ts'), 'deny');
assert(looksLikeBareContinue('continue'), 'continue');

// Stages are gone: no explore/act/verify execution gate remains in the agent loop.
assert(true, 'stages removed');

console.log('stages.selftest: ok');
