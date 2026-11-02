/**
 * Anthropic-style `<invoke name="…"><parameter name="…">v</parameter></invoke>` XML, leaked by
 * MiniMax M1 / M2.1 / M2.5 / M2.7 / M3 (wrapped in `<minimax:tool_call>`) and by Claude via
 * OpenRouter (bare, no wrapper) or generic OpenAI-compat proxies. MiniMax M2 also has a
 * malformed variant that drops every `<` / `</` angle bracket
 * (`invoke name="x">` … `parameter name="y">val parameter>`); repaired before parsing.
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const WRAP_RE = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/gi;
const INVOKE_RE = /<invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi;
const PARAM_RE = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
const DETECT_RE = /<minimax:tool_call>|<invoke\s+name\s*=|invoke\s+name\s*=\s*"[^"]+"\s*>/i;

/** M2's bracket-dropped variant: insert the missing `<` / `</` so the XML regexes above apply. */
function repairBrokenAngles(text: string): string {
	return text
		.replace(/(^|[^<])\binvoke\s+name\s*=\s*"([^"]+)"\s*>/g, '$1<invoke name="$2">')
		.replace(/(^|[^<])\bparameter\s+name\s*=\s*"([^"]+)"\s*>/g, '$1<parameter name="$2">')
		// Only insert the missing `</` when the tag is not already a well-formed closer —
		// i.e. not already preceded by `<` (open tag) or `/` (an existing `</parameter>`).
		.replace(/(?<![</])\bparameter>/g, '</parameter>')
		.replace(/(?<![</])\binvoke>/g, '</invoke>');
}

function coerceValue(raw: string): unknown {
	const v = raw.trim();
	if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
		try {
			return JSON.parse(v);
		} catch {
			/* keep string */
		}
	}
	return v;
}

function parseInvokes(body: string, startIndex: number): LiftedToolCall[] {
	const out: LiftedToolCall[] = [];
	const invokeRe = new RegExp(INVOKE_RE.source, 'gi');
	let im: RegExpExecArray | null;
	while ((im = invokeRe.exec(body))) {
		const args: Record<string, unknown> = {};
		const paramRe = new RegExp(PARAM_RE.source, 'gi');
		let pm: RegExpExecArray | null;
		while ((pm = paramRe.exec(im[2]))) {
			args[pm[1]] = coerceValue(pm[2]);
		}
		out.push({ id: `minimax_${startIndex + out.length}`, type: 'function', function: { name: im[1], arguments: JSON.stringify(args) } });
	}
	return out;
}

export const minimaxParser: GrammarParser = {
	id: 'minimax',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(repairBrokenAngles(masked))) return { calls: [], cleanedText: text };

		// Angle-bracket repair can insert characters, shifting indices relative to the raw
		// text. Apply it identically to the masked text (for matching) and to the original
		// text (for the final slice), so span indices line up in both — the repair patterns
		// never match inside a masked (blanked) fence, so the two stay aligned outside fences.
		const repairedMasked = repairBrokenAngles(masked);
		const repairedOriginal = repairBrokenAngles(text);

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];

		const wrapRe = new RegExp(WRAP_RE.source, 'gi');
		let wm: RegExpExecArray | null;
		while ((wm = wrapRe.exec(repairedMasked))) {
			const fromWrap = parseInvokes(wm[1], calls.length);
			if (fromWrap.length) {
				calls.push(...fromWrap);
				spans.push([wm.index, wm.index + wm[0].length]);
			}
		}

		if (!calls.length) {
			// Bare <invoke> without the minimax wrapper (Claude-via-OpenRouter, generic proxies).
			const invokeRe = new RegExp(INVOKE_RE.source, 'gi');
			let im: RegExpExecArray | null;
			while ((im = invokeRe.exec(repairedMasked))) {
				const fromBare = parseInvokes(im[0], calls.length);
				if (fromBare.length) {
					calls.push(...fromBare);
					spans.push([im.index, im.index + im[0].length]);
				}
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(repairedOriginal, spans).trim();
		return { calls, cleanedText };
	},
};
