/**
 * Qwen / Hermes family (`<tool_call>` + `<function=…>` + `<parameter=…>`, or JSON inside
 * `<tool_call>`). Wraps the existing `xmlToolCalls.ts` (not modified) and adds the broken
 * variants the survey calls out: merged tags missing the leading `<`, and a bare
 * `<parameter=…>` block with no `<tool_call>`/`<function=…>` wrapper at all.
 */

import { looksLikeXmlToolMarkup, parseXmlToolCalls } from '../../xmlToolCalls';
import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser } from './types';

/** `function=edit>` / `parameter=path>` missing the leading `<` (model dropped one token). */
function repairMergedTags(text: string): string {
	return text
		.replace(/(^|[^<])\bfunction\s*=\s*([A-Za-z0-9_.:-]+)>/g, '$1<function=$2>')
		.replace(/(^|[^<])\bparameter\s*=\s*([A-Za-z0-9_]+)>/g, '$1<parameter=$2>');
}

const DETECT_RE = /<tool_call\b|<function\s*=|<parameter\s*=|\bfunction\s*=\s*[A-Za-z0-9_.:-]+>/i;

export const qwenParser: GrammarParser = {
	id: 'qwen',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		const repairedMasked = repairMergedTags(masked);
		let calls = looksLikeXmlToolMarkup(repairedMasked) ? parseXmlToolCalls(repairedMasked) : [];
		calls = requireKnownTool(calls, ctx.toolNames);

		if (!calls.length) return { calls: [], cleanedText: text };

		// Strip the recovered markup from the visible text. We don't track exact per-call
		// spans (parseXmlToolCalls rebuilds from matched blocks), so remove the whole
		// <tool_call>…</tool_call> / <function=…>…</function> regions we matched on.
		const spans: Array<[number, number]> = [];
		const blockRe = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>|<function\s*=[\s\S]*?<\/function>/gi;
		let m: RegExpExecArray | null;
		while ((m = blockRe.exec(masked))) spans.push([m.index, m.index + m[0].length]);
		// Unclosed trailing block (model cut off mid-call).
		if (!spans.length) {
			const open = /<tool_call\b[^>]*>[\s\S]*$/i.exec(masked);
			if (open) spans.push([open.index, open.index + open[0].length]);
		}
		const cleanedText = spans.length ? removeSpans(text, spans).trim() : text;
		return { calls, cleanedText };
	},
};
