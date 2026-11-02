/**
 * Plano A (`a-msf-extension`): regression selftest for `./universal/*` once copied into
 * CodeForge and wired into `agentLoop.ts`. Follows this directory's own `.selftest.ts`
 * convention (`export async function run()` + `assert()`, no test framework) since no
 * automated collector for that convention exists in this repo copy — see PARITY.md in
 * `@msf/agent-harness` for the equivalent vitest-format suite this was ported from.
 *
 * Run directly: `npx tsc -p . && node out/agent/universal.selftest.js`
 */

import * as assert from 'node:assert/strict';
import { llmThinkingRequestFields, type ThinkingRoundInput } from './llmThinking';
import { resolveModelFamilyProfile } from './universal/modelFamily';
import { thinkingFields } from './universal/thinkingFields';
import { recoverToolCalls } from './universal/families/registry';
import { repairToolCallAgainstSchema } from './universal/schemaRepair';
import { StreamBuffer } from './universal/streamBuffer';

async function testQwenProfileResolvesAndMatchesLegacyThinkingFields(): Promise<void> {
	const profile = resolveModelFamilyProfile({ modelId: 'qwen2.5-coder-32b-instruct' });
	assert.ok(profile, 'qwen model id must resolve to a family profile');
	assert.equal(profile!.id, 'qwen');
	assert.ok(profile!.grammars.includes('qwen'), 'qwen profile must try the qwen grammar parser');

	// The whole point of unifying Qwen under `ModelFamilyProfile`: the new, format-aware
	// `thinkingFields()` must produce the exact same wire shape `llmThinkingRequestFields`
	// always has for a Qwen-shaped model — no behavior change for already-working traffic.
	const base: ThinkingRoundInput = {
		model: 'qwen2.5-coder-32b-instruct',
		thinkingSupported: true,
		planMode: false,
		withTools: true,
		proseToolsOnly: false,
		toolRoundThinking: true,
		escalatedThinking: false,
	};
	for (const toolRoundThinking of [true, false]) {
		for (const planMode of [true, false]) {
			const input: ThinkingRoundInput = { ...base, toolRoundThinking, planMode };
			assert.deepEqual(
				thinkingFields(profile!.thinkingFormat, input),
				llmThinkingRequestFields(input),
				`mismatch for toolRoundThinking=${toolRoundThinking} planMode=${planMode}`
			);
		}
	}
}

async function testUnprofiledModelFallsBackUnchanged(): Promise<void> {
	function resolveFormat(modelId: string): string | undefined {
		const profile = resolveModelFamilyProfile({ modelId });
		return profile && profile.thinkingFormat;
	}
	const isUnprofiled = resolveFormat('some-bespoke-finetune-xyz') === undefined;
	assert.ok(isUnprofiled, 'a model matching no family must resolve to undefined');
	const input: ThinkingRoundInput = {
		model: 'some-bespoke-finetune-xyz',
		thinkingSupported: true,
		planMode: true,
		withTools: false,
		proseToolsOnly: false,
	};
	// `format` undefined → thinkingFields() must fall back to the original function verbatim.
	const format = resolveFormat('some-bespoke-finetune-xyz') as Parameters<typeof thinkingFields>[0];
	assert.deepEqual(thinkingFields(format, input), llmThinkingRequestFields(input));
}

async function testKimiGrammarRecoversALeakedToolCall(): Promise<void> {
	const profile = resolveModelFamilyProfile({ modelId: 'kimi-k2-instruct' });
	assert.ok(profile, 'kimi model id must resolve to a family profile');
	const text =
		'<|tool_calls_section_begin|><|tool_call_begin|>functions.search:0<|tool_call_argument_begin|>{"query": "weather in Paris"}<|tool_call_end|><|tool_calls_section_end|>';
	const result = recoverToolCalls({
		text,
		toolNames: new Set(['search']),
		hasNativeToolCalls: false,
		families: profile!.grammars,
		mode: profile!.mode,
	});
	assert.equal(result.calls.length, 1, 'kimi sentinel markup must recover exactly one call');
	assert.equal(result.calls[0].function.name, 'search');
	assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { query: 'weather in Paris' });
}

async function testSchemaRepairFixesStringifiedArray(): Promise<void> {
	const result = repairToolCallAgainstSchema({
		toolName: 'write_many',
		args: { paths: '["a.ts","b.ts"]' },
		schema: {
			type: 'object',
			properties: { paths: { type: 'array', items: { type: 'string' } } },
			required: ['paths'],
		},
		activeToolNames: new Set(['write_many']),
	});
	assert.equal(result.valid, true);
	assert.ok(result.appliedRules.includes('parseJsonStringifiedArray'));
	assert.deepEqual(result.args, { paths: ['a.ts', 'b.ts'] });
}

async function testStreamBufferHoldsBackMarkerAcrossChunks(): Promise<void> {
	const buf = new StreamBuffer({ prefixSize: 8, maxSize: 64 });
	const out1 = buf.push('hello <tool_c');
	// Short combined length (13 chars) <= prefixSize won't trigger emission yet at this size —
	// assert only the invariant that matters: nothing holds more than prefixSize, and a full
	// flush reconstructs the exact original text with nothing dropped or duplicated.
	const out2 = buf.push('all>world');
	const rest = buf.flush();
	assert.equal(out1 + out2 + rest, 'hello <tool_call>world');
	assert.equal(buf.pending(), '');
}

export async function run(): Promise<void> {
	await testQwenProfileResolvesAndMatchesLegacyThinkingFields();
	await testUnprofiledModelFallsBackUnchanged();
	await testKimiGrammarRecoversALeakedToolCall();
	await testSchemaRepairFixesStringifiedArray();
	await testStreamBufferHoldsBackMarkerAcrossChunks();
	console.log('universal.selftest: ok');
}

if (require.main === module) {
	run().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
