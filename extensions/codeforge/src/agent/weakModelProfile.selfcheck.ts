/**
 * Sanity checks for weak-model mode resolution (run via ts-node or manual review).
 */

import { isWeakModel, resolveWeakModelMode } from './weakModelProfile';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

export function runWeakModelSelfCheck(): void {
	assert(resolveWeakModelMode('on') === 'on', 'on');
	assert(resolveWeakModelMode('off') === 'off', 'off');
	assert(resolveWeakModelMode('force') === 'on', 'legacy force → on');
	assert(resolveWeakModelMode('auto') === 'off', 'legacy auto → off');
	assert(resolveWeakModelMode(undefined) === 'off', 'default off');
	assert(resolveWeakModelMode('garbage') === 'off', 'unknown → off');
	assert(isWeakModel({ modelId: 'bonsai-2-27b' }, 'off') === false, 'off ignores size');
	assert(isWeakModel({ modelId: 'gpt-4o' }, 'on') === true, 'on ignores strong name');
	assert(isWeakModel({}, 'on') === true, 'on with empty hints');
}
