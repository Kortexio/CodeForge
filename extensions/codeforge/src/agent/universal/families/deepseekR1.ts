/**
 * DeepSeek R1-era sentinel format (ik_llama.cpp #676): `<｜tool▁calls▁begin｜>` wrapping one or
 * more `<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n```json\n{...}\n```<｜tool▁call▁end｜>`,
 * a degraded single call missing the outer wrapper, and a bare `{"tools":[...]}` JSON array.
 * The `<tool_call>` + stray `</think>` variant is handled generically by the registry
 * (strips an orphan `</think>` found between an open `<tool_call>` and its close) before the
 * qwen parser runs, since that shape is plain Qwen/Hermes XML once cleaned.
 *
 * Unlike every other family parser here, this one does NOT run `maskCodeFences` first: the
 * sentinel format's argument payload is itself a genuine ` ```json ``` ` fence (the fence is
 * the envelope, not decorative example code), so masking it would blank out the very JSON this
 * parser needs to read — the same exception noted in `minimaxText.ts`.
 */

import { removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const SENTINEL_BLOCK_RE =
	/<｜tool▁calls▁begin｜>([\s\S]*?)<｜tool▁calls▁end｜>/gi;
const SENTINEL_CALL_RE =
	/<｜tool▁call▁begin｜>\s*function\s*<｜tool▁sep｜>\s*([A-Za-z0-9_.:-]+)\s*\n?```json\s*([\s\S]*?)```\s*<｜tool▁call▁end｜>/gi;
/** Degraded single call: sentinel tokens present but no outer tool_calls wrapper. */
const BARE_CALL_RE =
	/function\s*<｜tool▁sep｜>\s*([A-Za-z0-9_.:-]+)\s*\n?```json\s*([\s\S]*?)```/gi;
const TOOLS_ARRAY_RE = /\{\s*"tools"\s*:\s*\[([\s\S]*?)\]\s*\}/g;

function callsFromSentinel(body: string): LiftedToolCall[] {
	const out: LiftedToolCall[] = [];
	let m: RegExpExecArray | null;
	const re = new RegExp(SENTINEL_CALL_RE.source, 'gi');
	while ((m = re.exec(body))) {
		const name = m[1];
		try {
			const args = JSON.parse(m[2].trim()) as Record<string, unknown>;
			out.push({ id: `dsr1_${out.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
		} catch {
			/* malformed JSON inside the fence — skip this call, do not guess */
		}
	}
	return out;
}

function callsFromToolsArray(inner: string, startIndex: number): LiftedToolCall[] {
	const out: LiftedToolCall[] = [];
	try {
		const arr = JSON.parse(`[${inner}]`) as Array<Record<string, unknown>>;
		for (const item of arr) {
			const name = item.name;
			if (typeof name !== 'string') continue;
			const args = (item.arguments ?? item.args ?? {}) as Record<string, unknown>;
			out.push({
				id: `dsr1_${startIndex + out.length}`,
				type: 'function',
				function: { name, arguments: JSON.stringify(typeof args === 'object' && args ? args : {}) },
			});
		}
	} catch {
		/* not valid JSON once wrapped — leave as text */
	}
	return out;
}

const DETECT_RE = /<｜tool▁calls?▁begin｜>|function\s*<｜tool▁sep｜>|"tools"\s*:\s*\[/i;

export const deepseekR1Parser: GrammarParser = {
	id: 'deepseek-r1',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		if (!DETECT_RE.test(text)) return { calls: [], cleanedText: text };

		const spans: Array<[number, number]> = [];
		let calls: LiftedToolCall[] = [];

		const blockRe = new RegExp(SENTINEL_BLOCK_RE.source, 'gi');
		let bm: RegExpExecArray | null;
		while ((bm = blockRe.exec(text))) {
			const fromBlock = callsFromSentinel(bm[1]);
			if (fromBlock.length) {
				calls.push(...fromBlock);
				spans.push([bm.index, bm.index + bm[0].length]);
			}
		}

		if (!calls.length) {
			const bareRe = new RegExp(BARE_CALL_RE.source, 'gi');
			let m: RegExpExecArray | null;
			while ((m = bareRe.exec(text))) {
				try {
					const args = JSON.parse(m[2].trim()) as Record<string, unknown>;
					calls.push({ id: `dsr1_${calls.length}`, type: 'function', function: { name: m[1], arguments: JSON.stringify(args) } });
					spans.push([m.index, m.index + m[0].length]);
				} catch {
					/* skip */
				}
			}
		}

		if (!calls.length) {
			const arrRe = new RegExp(TOOLS_ARRAY_RE.source, 'g');
			let m: RegExpExecArray | null;
			while ((m = arrRe.exec(text))) {
				const fromArr = callsFromToolsArray(m[1], calls.length);
				if (fromArr.length) {
					calls.push(...fromArr);
					spans.push([m.index, m.index + m[0].length]);
				}
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
