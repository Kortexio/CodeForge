/**
 * Gemma 4 marker (`<|tool_call>call:Name{args}<tool_call|>`, llama.cpp #22786 / #21680).
 * The argument body is frequently not valid JSON (fused braces, e.g. `{count` or a bare `$`
 * where a key was expected) — that is not a grammar problem, it is the truncated/garbled-JSON
 * case the existing retry path already handles. This parser recovers the call shape and tries
 * a couple of light JSON repairs; if the body still does not parse, it returns the call with a
 * `__invalidJson` sentinel so `schemaRepair` rejects it and the caller retries with the error,
 * instead of silently guessing arguments.
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const CALL_RE = /<\|tool_call>\s*call\s*:\s*([A-Za-z0-9_.:-]+)\s*(\{[\s\S]*?\})\s*<tool_call\|>/gi;
const DANGLING_RE = /<\|tool_call>\s*call\s*:\s*([A-Za-z0-9_.:-]+)\s*(\{[\s\S]*)$/i;
const DETECT_RE = /<\|tool_call>\s*call\s*:/i;

function tryParseArgs(raw: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		/* fall through to light repair */
	}
	// Light repair: quote bare keys, drop trailing commas. Conservative — bail on anything
	// weirder (fused `{count` / stray `$`) rather than guess.
	const repaired = raw
		.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
		.replace(/,\s*([}\]])/g, '$1');
	try {
		return JSON.parse(repaired) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export const gemma4Parser: GrammarParser = {
	id: 'gemma4',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];
		const re = new RegExp(CALL_RE.source, 'gi');
		let m: RegExpExecArray | null;
		while ((m = re.exec(masked))) {
			const name = m[1];
			const args = tryParseArgs(m[2]);
			calls.push({
				id: `gemma4_${calls.length}`,
				type: 'function',
				function: { name, arguments: args ? JSON.stringify(args) : JSON.stringify({ __invalidJson: m[2] }) },
			});
			spans.push([m.index, m.index + m[0].length]);
		}

		if (!calls.length) {
			const dm = DANGLING_RE.exec(masked);
			if (dm) {
				const args = tryParseArgs(dm[2]);
				if (args) {
					calls.push({ id: 'gemma4_0', type: 'function', function: { name: dm[1], arguments: JSON.stringify(args) } });
					spans.push([dm.index, dm.index + dm[0].length]);
				} else {
					// Unterminated and unparseable — strip for hygiene only, no call.
					const cleanedText = removeSpans(text, [[dm.index, dm.index + dm[0].length]]).trim();
					return { calls: [], cleanedText };
				}
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
