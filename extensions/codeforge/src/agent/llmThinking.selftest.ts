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
assert(toolSamp.presence_penalty === 1.0, 'tool presence_penalty');
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
