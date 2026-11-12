/**
 * Unit checks for llama.cpp slot parsing (no test runner wired — run via node).
 */
import {
	capsFromArgs,
	clearLlamaSlotCache,
	contextWindowFromModelsList,
	effectiveContextBudget,
	parseLlamaSlots,
	parseModelStatusArgs,
	seedLlamaSlotCache,
	serverRoot,
	shouldProbeLlamaSlots,
	slotCap,
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

assert(
	contextWindowFromModelsList({
		data: [{ id: 'qwen', meta: { n_ctx: 92160 } }],
	}) === 92160,
	'llama.cpp meta.n_ctx'
);
assert(
	contextWindowFromModelsList({
		data: [
			{ id: 'a', meta: { n_ctx: 32768 } },
			{ id: 'b', max_model_len: 65536 },
		],
	}) === 65536,
	'max across models'
);
assert(contextWindowFromModelsList({ data: [{ id: 'gpt' }] }) === undefined, 'no ctx fields');
assert(contextWindowFromModelsList({ data: [{ id: 'tiny', meta: { n_ctx: 512 } }] }) === undefined, 'below floor');

clearLlamaSlotCache();
assert(slotCap() === 1, 'unprobed cap is 1');
assert(slotCap('lan', 'qwen') === 1, 'unknown pair is 1');
seedLlamaSlotCache('lan', 'qwen', { parallel: 4, slotContext: 23040, kvUnified: false });
assert(slotCap() === 4, 'cached parallel');
assert(slotCap('lan', 'qwen') === 4, 'matching pair');
assert(slotCap('other', 'qwen') === 1, 'mismatch pair stays 1');
clearLlamaSlotCache();

console.log('llamaSlots.selftest ok');
