/**
 * Quick sanity checks for weak-model detection (run via ts-node or manual review).
 * Kept as a .ts module so tsc typechecks the heuristics.
 */

import { isWeakModel, parseParamsBillions } from './weakModelProfile';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

export function runWeakModelSelfCheck(): void {
	assert(parseParamsBillions('Qwen3-32B-exl3') === 32, '32b parse');
	assert(parseParamsBillions('gemma-4-31B-it') === 31, '31b parse');
	assert(parseParamsBillions('8x7b') === 56, 'moe parse');
	assert(isWeakModel({ modelId: 'Qwen3-32B-exl3' }), '32b weak');
	assert(isWeakModel({ modelId: 'claude-sonnet-5' }) === false, 'sonnet not weak');
	assert(isWeakModel({ modelId: 'gpt-4o' }) === false, 'gpt4 not weak');
	assert(
		isWeakModel({ modelId: 'local-model', baseUrl: 'http://192.168.1.65:14563/v1', numCtx: 2048 }),
		'lan+small ctx weak'
	);
	assert(isWeakModel({ modelId: 'foo' }, 'force') === true, 'force');
	assert(isWeakModel({ modelId: 'Qwen3-8B' }, 'off') === false, 'off');
}
