/**
 * Moonshot Kimi K2 / K2-Thinking / K2.6 sentinel tokens. Singular/plural section wrapper
 * variants exist (`tool_call_section_begin` vs `tool_calls_section_begin`). The id format is
 * load-bearing: `functions.{name}:{idx}` — `requestPrep.normalizeToolCallIds` keeps replayed
 * history in this shape so the model does not see OpenAI-style ids and leak again.
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const SECTION_RE = /<\|tool_calls?_section_begin\|>([\s\S]*?)<\|tool_calls?_section_end\|>/gi;
const CALL_RE =
	/<\|tool_call_begin\|>\s*functions\.([A-Za-z0-9_.:-]+)\s*:\s*(\d+)\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/gi;
const DETECT_RE = /<\|tool_calls?_section_(?:begin|end)\|>|<\|tool_call_(?:begin|end|argument_begin)\|>/i;

export const kimiParser: GrammarParser = {
	id: 'kimi',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];

		const sectionRe = new RegExp(SECTION_RE.source, 'gi');
		let sm: RegExpExecArray | null;
		while ((sm = sectionRe.exec(masked))) {
			const callRe = new RegExp(CALL_RE.source, 'gi');
			let cm: RegExpExecArray | null;
			let any = false;
			while ((cm = callRe.exec(sm[1]))) {
				try {
					const args = JSON.parse(cm[3].trim()) as Record<string, unknown>;
					calls.push({ id: `functions.${cm[1]}:${cm[2]}`, type: 'function', function: { name: cm[1], arguments: JSON.stringify(args) } });
					any = true;
				} catch {
					/* skip malformed call inside the section */
				}
			}
			if (any) spans.push([sm.index, sm.index + sm[0].length]);
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
