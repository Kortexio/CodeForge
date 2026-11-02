/**
 * OLMo3: `<function_calls>` wrapping one pythonic call per line
 * (`func(arg1="val", arg2=2)`), newline-delimited, no per-call id.
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import { parsePythonicArgs } from './llama';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const BLOCK_RE = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
const LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\(([^)]*)\)\s*$/;
const DETECT_RE = /<function_calls>/i;

export const olmoParser: GrammarParser = {
	id: 'olmo',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];
		const blockRe = new RegExp(BLOCK_RE.source, 'gi');
		let bm: RegExpExecArray | null;
		while ((bm = blockRe.exec(masked))) {
			const lines = bm[1].split('\n');
			let any = false;
			for (const line of lines) {
				const lm = LINE_RE.exec(line);
				if (!lm) continue;
				const args = parsePythonicArgs(lm[2]);
				if (!args) continue;
				calls.push({ id: `olmo_${calls.length}`, type: 'function', function: { name: lm[1], arguments: JSON.stringify(args) } });
				any = true;
			}
			if (any) spans.push([bm.index, bm.index + bm[0].length]);
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
