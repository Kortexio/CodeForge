/**
 * MiniMax-Text-01 emits the call itself inside a fenced ```typescript block:
 * ` ```typescript\nfunctions.search({"query": "..."})\n``` `. Unlike every other family
 * parser, this one deliberately targets fence content instead of ignoring it — the fence here
 * is the tool-call envelope, not prose example code — so it does not use `maskCodeFences`.
 */

import { extractBalancedBraces, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const DETECT_RE = /```typescript[\s\S]*?functions\.[A-Za-z0-9_.:-]+\s*\(/i;
const CALL_START_RE = /```typescript\s*\n?\s*functions\.([A-Za-z0-9_.:-]+)\s*\(\s*(\{)/gi;
const CLOSE_RE = /^\s*\)\s*\n?```/;

export const minimaxTextParser: GrammarParser = {
	id: 'minimax-text',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		if (!DETECT_RE.test(text)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];
		const re = new RegExp(CALL_START_RE.source, 'gi');
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const openIndex = m.index + m[0].length - 1;
			const obj = extractBalancedBraces(text, openIndex);
			if (!obj) continue;
			const closeMatch = CLOSE_RE.exec(text.slice(obj.endIndex));
			if (!closeMatch) continue;
			try {
				const args = JSON.parse(obj.json) as Record<string, unknown>;
				calls.push({ id: `minimaxtext_${calls.length}`, type: 'function', function: { name: m[1], arguments: JSON.stringify(args) } });
				spans.push([m.index, obj.endIndex + closeMatch[0].length]);
			} catch {
				/* malformed JSON — leave as text */
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
