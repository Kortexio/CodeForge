/**
 * Zhipu/Z.ai GLM-4.5 / 4.6 / 4.7 / 5: `<tool_call>name\n<arg_key>k</arg_key><arg_value>v</arg_value>…</tool_call>`.
 * Zero-arg calls (`<tool_call>get_current_date</tool_call>`) and same-line name+args are valid.
 * Values are plain text by default; a value that looks like JSON (object/array/number/bool) is
 * parsed so numeric/boolean/array arguments round-trip.
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
const NAME_RE = /^[A-Za-z0-9_.:-]+$/;
const DETECT_RE = /<tool_call>[\s\S]*?<\/tool_call>/i;

function coerceGlmValue(raw: string): unknown {
	const v = raw.trim();
	if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
		try {
			return JSON.parse(v);
		} catch {
			/* keep as string */
		}
	}
	return v;
}

export const glmParser: GrammarParser = {
	id: 'glm',
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
			const body = bm[1];
			const firstArg = ARG_RE.exec(body);
			ARG_RE.lastIndex = 0;
			const nameRaw = (firstArg ? body.slice(0, firstArg.index) : body).trim();
			if (!NAME_RE.test(nameRaw)) continue;

			const args: Record<string, unknown> = {};
			const argRe = new RegExp(ARG_RE.source, 'gi');
			let am: RegExpExecArray | null;
			while ((am = argRe.exec(body))) {
				args[am[1].trim()] = coerceGlmValue(am[2]);
			}
			calls.push({ id: `glm_${calls.length}`, type: 'function', function: { name: nameRaw, arguments: JSON.stringify(args) } });
			spans.push([bm.index, bm.index + bm[0].length]);
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
