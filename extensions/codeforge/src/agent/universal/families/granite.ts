/**
 * IBM Granite 4.0 / 4.1 (+ Nano): Hermes-style `<tool_call>{"name": …, "arguments": …}</tool_call>`,
 * with a known quirk where `arguments` arrives as an escaped JSON *string* instead of an object
 * (the shared Qwen/Hermes parser only unwraps that under `function.arguments`, not the
 * top-level `name`/`arguments` shape Granite uses). Granite 3.3 / 4.0 H-Small instead emit a
 * bare pythonic call (`func(kw=val)`) with no wrapper at all — recovered only when the whole
 * trimmed content is exactly one such call, to avoid matching a sentence that merely mentions
 * a function.
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import { parsePythonicArgs } from './llama';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const BARE_PYTHONIC_RE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\(([^()]*)\)\s*$/;
const DETECT_RE = /<tool_call>[\s\S]*?<\/tool_call>|^\s*[A-Za-z_][A-Za-z0-9_.]*\([^()]*\)\s*$/i;

function callFromJsonBlock(body: string, index: number): LiftedToolCall | undefined {
	try {
		const obj = JSON.parse(body.trim()) as Record<string, unknown>;
		if (typeof obj.name !== 'string') return undefined;
		let args = obj.arguments ?? obj.args;
		if (typeof args === 'string') {
			try {
				args = JSON.parse(args);
			} catch {
				return undefined;
			}
		}
		return {
			id: `granite_${index}`,
			type: 'function',
			function: { name: obj.name, arguments: JSON.stringify(typeof args === 'object' && args ? args : {}) },
		};
	} catch {
		return undefined;
	}
}

export const graniteParser: GrammarParser = {
	id: 'granite',
	detect(text: string): boolean {
		return DETECT_RE.test(text.trim()) || /<tool_call>/i.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];

		const blockRe = new RegExp(BLOCK_RE.source, 'gi');
		let bm: RegExpExecArray | null;
		while ((bm = blockRe.exec(masked))) {
			const call = callFromJsonBlock(bm[1], calls.length);
			if (call) {
				calls.push(call);
				spans.push([bm.index, bm.index + bm[0].length]);
			}
		}

		if (!calls.length) {
			const bare = BARE_PYTHONIC_RE.exec(masked.trim());
			if (bare) {
				const args = parsePythonicArgs(bare[2]);
				if (args) {
					calls.push({ id: 'granite_0', type: 'function', function: { name: bare[1], arguments: JSON.stringify(args) } });
					spans.push([masked.indexOf(bare[0]), masked.indexOf(bare[0]) + bare[0].length]);
				}
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
