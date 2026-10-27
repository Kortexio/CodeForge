/**
 * Unit checks for thinking / CoT request controls (run via compiled out/).
 */
import {
	applySoftThinkSwitch,
	llmSamplingOptions,
	llmThinkingRequestFields,
	modelLikelySupportsThinking,
	shouldDisableThinking,
	shouldEnableThinking,
	splitThinkContent,
	stripReasoningFromMessages,
	supportsThinking,
	thinkingProbeObserved,
	thinkingProbeRequest,
	toolAwareMaxTokens,
} from './llmThinking';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(modelLikelySupportsThinking('Qwen3-32B'), 'qwen3 thinks');
assert(modelLikelySupportsThinking('DeepSeek-R1-Distill'), 'r1 thinks');
assert(!modelLikelySupportsThinking('llama-3.1-8b'), 'llama no think gate');

const toolRound = {
	model: 'qwen3-30b',
	withTools: true,
	planMode: false,
};
assert(shouldDisableThinking(toolRound), 'tools → disable');
assert(!shouldEnableThinking(toolRound), 'tools → not enable');
assert(llmThinkingRequestFields(toolRound).enable_thinking === false, 'enable_thinking false');
assert(
	(llmThinkingRequestFields(toolRound).chat_template_kwargs as { enable_thinking: boolean })
		.enable_thinking === false,
	'chat_template_kwargs false'
);

const planRound = { model: 'qwen3-30b', planMode: true, withTools: true };
assert(!shouldDisableThinking(planRound), 'plan keeps thinking');
assert(shouldEnableThinking(planRound), 'plan enables');
assert(llmThinkingRequestFields(planRound).enable_thinking === true, 'plan enable_thinking true');

const plain = { model: 'gpt-4o-mini', withTools: true };
assert(!shouldDisableThinking(plain), 'non-think model: no flags');
assert(Object.keys(llmThinkingRequestFields(plain)).length === 0, 'empty fields');

const toolSamp = llmSamplingOptions(toolRound);
assert(toolSamp.temperature === 0.7 && toolSamp.top_p === 0.8, 'tool sampling');
assert(toolSamp.presence_penalty === 0, 'tool rounds send presence_penalty 0 (tool calls repeat tokens)');
const planSamp = llmSamplingOptions(planRound);
assert(planSamp.temperature === 0.6 && planSamp.top_p === 0.95, 'plan sampling');
const plainSamp = llmSamplingOptions(plain);
assert(plainSamp.temperature === 0.2, 'plain sampling');
assert(plainSamp.presence_penalty === undefined, 'plain no presence_penalty');

assert(
	toolAwareMaxTokens(8192, { ...toolRound, tools: [{ function: { name: 'read' } }] }) === 3072,
	'read cap'
);
assert(
	toolAwareMaxTokens(8192, { ...toolRound, tools: [{ function: { name: 'write' } }] }) === 6144,
	'write cap'
);
assert(toolAwareMaxTokens(8192, { model: 'llama', withTools: true }) === 8192, 'no cap non-think');
assert(
	toolAwareMaxTokens(8192, { ...planRound, tools: [{ function: { name: 'read' } }] }) === 8192,
	'plan no cap'
);

const split = splitThinkContent('hello <think>secret</think>\nworld');
assert(split.content === 'hello\nworld' || split.content.includes('hello'), 'strip think keep prose');
assert(split.reasoning.includes('secret'), 'capture think');
assert(!split.content.includes('<think'), 'no think tags left');

const escalated = {
	model: 'qwen3.6-35b',
	withTools: true,
	toolRoundThinking: false,
	escalatedThinking: true,
	thinkingSupported: true as boolean | undefined,
};
assert(!shouldDisableThinking(escalated), 'escalated → not disabled');
assert(shouldEnableThinking(escalated), 'escalated → enable_thinking after stumble');
assert(
	llmThinkingRequestFields(escalated).enable_thinking === true,
	'escalated enable_thinking true'
);
const hybridQuiet = {
	model: 'qwen3.6-35b',
	withTools: true,
	toolRoundThinking: false,
	escalatedThinking: false,
	thinkingSupported: true as boolean | undefined,
};
assert(shouldDisableThinking(hybridQuiet), 'hybrid quiet round disables thinking');
assert(!shouldEnableThinking(hybridQuiet), 'hybrid quiet round does not enable');

const thinkTools = { model: 'qwen3.6-35b', withTools: true, toolRoundThinking: true };
assert(!shouldDisableThinking(thinkTools), 'toolRounds knob → not disabled');
assert(shouldEnableThinking(thinkTools), 'toolRounds knob → enabled');
assert(llmThinkingRequestFields(thinkTools).enable_thinking === true, 'toolRounds enable_thinking true');
assert(
	(llmThinkingRequestFields(thinkTools).chat_template_kwargs as { enable_thinking: boolean })
		.enable_thinking === true,
	'toolRounds chat_template_kwargs true'
);
const thinkSamp = llmSamplingOptions(thinkTools);
assert(
	thinkSamp.temperature === 0.7 && thinkSamp.top_p === 0.8 && thinkSamp.presence_penalty === 0,
	'toolRounds without a toolReasoning slice keeps the tool sampling (only thinking changes)'
);
const sliced = llmSamplingOptions(thinkTools, {
	plan: { temperature: 0.6, top_p: 0.95 },
	toolThinking: { temperature: 0.3, top_p: 0.8, presence_penalty: 0 },
	toolReasoning: { temperature: 0.55, top_p: 0.9, presence_penalty: 0 },
	plain: { temperature: 0.2, top_p: 1 },
});
assert(sliced.temperature === 0.55 && sliced.top_p === 0.9, 'toolRounds uses the toolReasoning slice');
const planSliced = llmSamplingOptions(planRound, {
	plan: { temperature: 0.6, top_p: 0.95 },
	toolThinking: { temperature: 0.3, top_p: 0.8, presence_penalty: 0 },
	toolReasoning: { temperature: 0.55, top_p: 0.9, presence_penalty: 0 },
	plain: { temperature: 0.2, top_p: 1 },
});
assert(planSliced.temperature === 0.6 && planSliced.top_p === 0.95, 'plan mode keeps plan sampling');
assert(
	toolAwareMaxTokens(8192, { ...thinkTools, tools: [{ function: { name: 'read' } }] }) === 8192,
	'toolRounds: reasoning is not starved by the read cap'
);
assert(
	Object.keys(llmThinkingRequestFields({ model: 'llama-3.1-8b', withTools: true, toolRoundThinking: true }))
		.length === 0,
	'toolRounds knob on a non-thinker sends no flags'
);
assert(
	!shouldEnableThinking({ model: 'qwen3.6-35b', withTools: false, toolRoundThinking: true }),
	'toolRounds knob does not force thinking on tool_choice none wraps'
);
const softThinkTools = applySoftThinkSwitch(
	[{ role: 'user', content: 'fix the bug' }],
	shouldDisableThinking(thinkTools)
);
assert(String(softThinkTools[0].content).endsWith('/think'), 'toolRounds soft switch is /think');

const measuredOff = { model: 'qwen3.6-35b', withTools: true, thinkingSupported: false };
assert(!supportsThinking(measuredOff), 'measured unsupported wins over the name');
assert(Object.keys(llmThinkingRequestFields(measuredOff)).length === 0, 'measured unsupported sends no flags');
assert(
	Object.keys(
		llmThinkingRequestFields({ ...measuredOff, toolRoundThinking: true })
	).length === 0,
	'knob on with measured unsupported still sends no flags'
);
const measuredOn = { model: 'acme-coder-30b', withTools: true, thinkingSupported: true };
assert(!modelLikelySupportsThinking('acme-coder-30b'), 'unknown name has no heuristic support');
assert(shouldDisableThinking(measuredOn), 'measured support turns thinking off on tool rounds by default');
assert(
	shouldEnableThinking({ ...measuredOn, toolRoundThinking: true }),
	'measured support + knob enables thinking for a model the name heuristic misses'
);
assert(
	toolAwareMaxTokens(
		32768,
		{ ...measuredOn, toolRoundThinking: true, tools: [{ function: { name: 'edit' } }] },
		{ mutatingMaxTokens: 6144, readOnlyMaxTokens: 3072, thinkingMaxTokens: 12288 }
	) === 12288,
	'thinking rounds use thinking.maxTokens, not the write cap'
);

const probeBody = thinkingProbeRequest('qwen3.6-35b');
assert(probeBody.enable_thinking === true, 'probe asks for thinking');
assert(Array.isArray(probeBody.tools) && probeBody.tools.length === 1, 'probe is a tool round');
assert(
	String((probeBody.messages as Array<{ content: string }>).at(-1)?.content).endsWith('/think'),
	'probe carries the soft switch'
);
assert(
	thinkingProbeObserved({
		content: null,
		reasoning_content: 'read coupons.js first',
		tool_calls: [{ function: { name: 'read', arguments: '{"path":"src/pricing/coupons.js"}' } }],
	}),
	'reasoning + tool call = supported'
);
assert(
	thinkingProbeObserved({ content: '<think>check expiry</think>The bug is the < comparison.' }),
	'inline think + answer = supported'
);
assert(
	!thinkingProbeObserved({ content: null, tool_calls: [{ function: { name: 'read' } }] }),
	'tool call without reasoning = not supported'
);
assert(
	!thinkingProbeObserved({ content: '', reasoning_content: 'thinking forever' }),
	'reasoning without any answer does not count'
);

const interleaved = stripReasoningFromMessages(
	[
		{ role: 'user', content: 'old task' },
		{ role: 'assistant', content: 'done', reasoning_content: 'old turn plan' },
		{ role: 'user', content: 'fix coupon expiry' },
		{ role: 'assistant', content: '', reasoning_content: 'read the spec first', tool_calls: [] },
		{ role: 'tool', content: 'FILE docs/pricing.md' },
		{ role: 'assistant', content: '<think>edit applyCoupon</think>', thinking: 'edit applyCoupon' },
	],
	{ keepCurrentTurn: true }
);
assert(interleaved[1].reasoning_content === undefined, 'previous turn reasoning dropped');
assert(interleaved[3].reasoning_content === 'read the spec first', 'current turn reasoning kept');
assert(interleaved[5].reasoning_content === 'edit applyCoupon', 'thinking field normalized');
assert(interleaved[5].thinking === undefined, 'thinking field removed');
assert(interleaved[5].content === '', 'inline think block still stripped from content');
assert(interleaved[4].reasoning_content === undefined, 'tool messages never carry reasoning');
const noKeep = stripReasoningFromMessages([
	{ role: 'user', content: 'task' },
	{ role: 'assistant', content: '', reasoning_content: 'plan' },
]);
assert(noKeep[1].reasoning_content === undefined, 'default still strips the current turn');

const stripped = stripReasoningFromMessages([
	{
		role: 'assistant',
		content: '<think>x</think>ok',
		reasoning_content: 'leak',
		thinking: 'also',
	},
]);
assert(stripped[0].content === 'ok', 'strip blocks');
assert(stripped[0].reasoning_content === undefined, 'drop reasoning_content');
assert(stripped[0].thinking === undefined, 'drop thinking');

const softOff = applySoftThinkSwitch(
	[
		{ role: 'system', content: 'You are agent.' },
		{ role: 'user', content: 'list files' },
	],
	true
);
assert(String(softOff[1].content).includes('/no_think'), 'soft /no_think on user');
assert(!String(softOff[0].content).includes('/no_think'), 'system stays clean');
const softOn = applySoftThinkSwitch([{ role: 'user', content: 'plan this\n/no_think' }], false);
assert(String(softOn[0].content).includes('/think'), 'soft /think');
assert(!String(softOn[0].content).includes('/no_think'), 'opposite tag removed');

assert(splitThinkContent('/no_think').content === '', 'echoed soft switch alone is empty');
assert(splitThinkContent('  /think  \n').content === '', 'echoed /think alone is empty');
assert(
	splitThinkContent('/no_think\nDone: renamed calcTax.').content === 'Done: renamed calcTax.',
	'echoed soft switch line stripped, text kept'
);
assert(
	splitThinkContent('Use the /no_think switch on tool rounds.').content ===
		'Use the /no_think switch on tool rounds.',
	'inline mention of the switch is kept'
);

console.log('llmThinking.selftest: ok');
