/**
 * Unit checks for llama.cpp slot parsing (no test runner wired — run via node).
 */
import {
	capsFromArgs,
	effectiveContextBudget,
	parseLlamaSlots,
	parseModelStatusArgs,
	serverRoot,
	shouldProbeLlamaSlots,
} from './llamaSlots';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(serverRoot('https://server.example/v1') === 'https://server.example', 'strip /v1');
assert(serverRoot('https://server.example/v1/') === 'https://server.example', 'strip /v1 slash');
assert(!shouldProbeLlamaSlots('https://api.openai.com/v1'), 'skip OpenAI cloud');
assert(shouldProbeLlamaSlots('https://server.kortexio.io/v1'), 'probe custom host');

const slots = parseLlamaSlots([
	{ id: 0, n_ctx: 65536 },
	{ id: 1, n_ctx: 65536 },
]);
assert(slots?.parallel === 2, 'two slots');
assert(slots?.slotContext === 65536, 'slot keeps full n_ctx');
assert(slots?.kvUnified === false, 'slots payload does not prove kv-unified');

const split = parseLlamaSlots([
	{ id: 0, n_ctx: 32768 },
	{ id: 1, n_ctx: 32768 },
]);
assert(split?.parallel === 2 && split.slotContext === 32768, 'split windows');

const unified = capsFromArgs([
	'--ctx-size',
	'65536',
	'--parallel',
	'2',
	'--kv-unified',
]);
assert(unified?.parallel === 2 && unified.slotContext === 65536 && unified.kvUnified, 'args unified');

const divided = capsFromArgs(['--ctx-size', '65536', '--parallel', '2']);
assert(divided?.slotContext === 32768 && divided.kvUnified === false, 'args divide ctx');

const fromModels = parseModelStatusArgs(
	{
		data: [
			{
				id: 'bonsai',
				status: { args: ['--ctx-size', '65536', '--parallel', '2', '--kv-unified'] },
			},
		],
	},
	'bonsai'
);
assert(fromModels?.parallel === 2 && fromModels.slotContext === 65536, 'model status args');

assert(effectiveContextBudget(65536, { parallel: 2, slotContext: 32768, kvUnified: false }) === 32768, 'clamp');
assert(effectiveContextBudget(8192, { parallel: 2, slotContext: 32768, kvUnified: false }) === 8192, 'keep smaller config');
assert(effectiveContextBudget(65536, undefined) === 65536, 'no caps');

console.log('llamaSlots.selftest ok');
