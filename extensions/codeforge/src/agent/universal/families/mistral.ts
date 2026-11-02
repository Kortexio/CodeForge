/**
 * Mistral sentinel tokens. Two shapes: `[TOOL_CALLS] [{...}]` (7B v0.3, Nemo, Ministral,
 * Large-2407) and the V11 tokenizer `[TOOL_CALLS]name[CALL_ID]id[ARGS]{...}`, repeated per call.
 */

import { extractBalancedBrackets, maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const DETECT_RE = /\[TOOL_CALLS\]/i;
const ARRAY_START_RE = /\[TOOL_CALLS\]\s*(\[)/gi;
const V11_CALL_RE = /\[TOOL_CALLS\]([A-Za-z0-9_.:-]+)\[CALL_ID\]([A-Za-z0-9]+)\[ARGS\](\{[\s\S]*?\})/gi;

function callsFromArray(arr: unknown[]): LiftedToolCall[] {
	const out: LiftedToolCall[] = [];
	for (const item of arr) {
		if (!item || typeof item !== 'object') continue;
		const row = item as Record<string, unknown>;
		if (typeof row.name !== 'string') continue;
		const args = (row.arguments ?? row.args ?? {}) as Record<string, unknown>;
		out.push({
			id: typeof row.id === 'string' ? row.id : `mistral_${out.length}`,
			type: 'function',
			function: { name: row.name, arguments: JSON.stringify(typeof args === 'object' && args ? args : {}) },
		});
	}
	return out;
}

export const mistralParser: GrammarParser = {
	id: 'mistral',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];

		const arrRe = new RegExp(ARRAY_START_RE.source, 'gi');
		let am: RegExpExecArray | null;
		while ((am = arrRe.exec(masked))) {
			const openIndex = am.index + am[0].length - 1;
			const obj = extractBalancedBrackets(masked, openIndex);
			if (!obj) continue;
			try {
				const arr = JSON.parse(obj.json) as unknown[];
				const fromArr = callsFromArray(arr);
				if (fromArr.length) {
					calls.push(...fromArr);
					spans.push([am.index, obj.endIndex]);
				}
			} catch {
				/* malformed — leave as text */
			}
		}

		if (!calls.length) {
			const v11Re = new RegExp(V11_CALL_RE.source, 'gi');
			let m: RegExpExecArray | null;
			while ((m = v11Re.exec(masked))) {
				try {
					const args = JSON.parse(m[3]) as Record<string, unknown>;
					calls.push({ id: m[2], type: 'function', function: { name: m[1], arguments: JSON.stringify(args) } });
					spans.push([m.index, m.index + m[0].length]);
				} catch {
					/* skip malformed call */
				}
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
