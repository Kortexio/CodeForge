/**
 * gpt-oss Harmony format leaked as plain text on OpenAI-compatible endpoints (Ollama and
 * similar): `to=functions.NAME ... <|message|>{...}<|call|>`, or the bare `to=functions.NAME
 * {...}` fragment when the channel tokens were stripped by the server.
 */

import { extractBalancedBraces, maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const DETECT_RE = /to=functions\.[A-Za-z0-9_.:-]+/i;
const CALL_START_RE = /to=functions\.([A-Za-z0-9_.:-]+)[^{]*?(\{)/gi;

export const harmonyParser: GrammarParser = {
	id: 'harmony',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];
		const re = new RegExp(CALL_START_RE.source, 'gi');
		let m: RegExpExecArray | null;
		while ((m = re.exec(masked))) {
			const openIndex = m.index + m[0].length - 1; // index of the '{'
			const obj = extractBalancedBraces(masked, openIndex);
			if (!obj) continue;
			try {
				const args = JSON.parse(obj.json) as Record<string, unknown>;
				calls.push({ id: `harmony_${calls.length}`, type: 'function', function: { name: m[1], arguments: JSON.stringify(args) } });
				// Include a trailing <|call|>/<|end|> marker in the removed span when present.
				const tailRe = /^\s*(?:<\|call\|>|<\|end\|>)?/i;
				const tail = tailRe.exec(masked.slice(obj.endIndex));
				const end = obj.endIndex + (tail ? tail[0].length : 0);
				spans.push([m.index, end]);
			} catch {
				/* malformed JSON — leave as text, do not guess */
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
