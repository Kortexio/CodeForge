/**
 * Microsoft Phi-4-mini tool-call marker: `functools[{"name": …, "arguments": {…}}, …]` — a
 * literal `functools` prefix followed by a JSON array of call objects.
 */

import { extractBalancedBrackets, maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const DETECT_RE = /\bfunctools\s*\[/i;
const START_RE = /\bfunctools\s*(\[)/gi;

export const phi4Parser: GrammarParser = {
	id: 'phi4',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];
		const re = new RegExp(START_RE.source, 'gi');
		let m: RegExpExecArray | null;
		while ((m = re.exec(masked))) {
			const openIndex = m.index + m[0].length - 1;
			const obj = extractBalancedBrackets(masked, openIndex);
			if (!obj) continue;
			try {
				const arr = JSON.parse(obj.json) as Array<Record<string, unknown>>;
				let any = false;
				for (const item of arr) {
					if (typeof item.name !== 'string') continue;
					const args = (item.arguments ?? item.args ?? {}) as Record<string, unknown>;
					calls.push({
						id: `phi4_${calls.length}`,
						type: 'function',
						function: { name: item.name, arguments: JSON.stringify(typeof args === 'object' && args ? args : {}) },
					});
					any = true;
				}
				if (any) spans.push([m.index, obj.endIndex]);
			} catch {
				/* malformed — leave as text */
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
