/**
 * Unit checks for internal scaffold plans (run via compiled out/).
 */
import {
	formatPlanForPrompt,
	hashTask,
	looksLikeBareContinue,
	looksLikeScaffoldTask,
	parseScaffoldPlanJson,
	pathAllowedByPlan,
	type InternalPlan,
} from './internalPlans';
import { stuckWrapPrompt } from './nudges';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(
	looksLikeScaffoldTask(
		'Gere um projeto completo de um jogo FPS 3D em TypeScript com package.json e vite'
	),
	'scaffold PT'
);
assert(!looksLikeScaffoldTask('onde está o Cart?'), 'not scaffold');
assert(looksLikeBareContinue('continue'), 'bare continue');
assert(looksLikeBareContinue('continua'), 'bare continua');
assert(!looksLikeBareContinue('continua o login'), 'not bare');
assert(hashTask('Hello World') === hashTask('  hello   world  '), 'hash normalize');

const plan: InternalPlan = {
	version: 1,
	id: 'abc',
	task: 'build fps',
	taskHash: hashTask('build fps'),
	sessionId: 'sess-1',
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	items: [
		{ id: '1', title: 'configs', status: 'done', paths: ['package.json'] },
		{ id: '2', title: 'core', status: 'pending', paths: ['src/index.ts'] },
	],
};
const prompt = formatPlanForPrompt(plan);
assert(prompt.includes('Focus now: [2]'), 'focus pending');
assert(prompt.includes('model-only'), 'model-only marker');
assert(pathAllowedByPlan(plan, 'src/index.ts'), 'path allowed');
assert(!pathAllowedByPlan(plan, 'other.ts'), 'path denied');
assert(pathAllowedByPlan(undefined, 'any.ts'), 'no plan = allow');
assert(!pathAllowedByPlan(plan, '.CodeForge/plans/x.json'), 'plans dir denied');

const parsed = parseScaffoldPlanJson(
	'Here:\n{"items":[{"title":"configs","paths":["package.json"]},{"title":"core"}]}\n'
);
assert(!!parsed && parsed.length === 2 && parsed[0].paths?.[0] === 'package.json', 'parse scaffold json');
assert(parseScaffoldPlanJson('not json') === undefined, 'reject bad json');

const stuck = stuckWrapPrompt('identical tool calls and results for 3 consecutive steps');
assert(/STUCK WITHOUT PROGRESS/i.test(stuck) && !/MAXIMUM STEPS/i.test(stuck), 'stuck wrap distinct');
assert(/State the stop reason above/i.test(stuck), 'stuck wrap asks for stop reason');
assert(stuck.includes('identical tool calls and results for 3 consecutive steps'), 'stuck wrap includes cause');

console.log('internalPlans.selftest: ok');
