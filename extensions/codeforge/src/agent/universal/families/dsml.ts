/**
 * DeepSeek "DSML" XML (V3.2 / V4-Pro / V4-Flash). Three bar variants plus an ASCII-pipe
 * proxy variant: double fullwidth bar (｜｜), single fullwidth bar (｜), no leading bar
 * (`<DSML｜…`), and spaced ASCII pipes (`< | DSML | …`). Outer wrapper is `tool_calls` (V4) or
 * `function_calls` (V3.2), singular or plural. `string="true"` keeps the value as text;
 * `string="false"` means the value is JSON (number/bool/array/object).
 */

import { maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

/** Fullwidth vertical bar (U+FF5C), doubled or single, or a spaced ASCII `|`. */
const BAR = '(?:\\uFF5C{1,2}|\\|)';
const WRAP = '(?:tool_calls?|function_calls?)';

function tag(name: string): RegExp {
	return new RegExp(`<\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*${name}\\s*>`, 'i');
}

const BLOCK_RE = new RegExp(
	`<\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*${WRAP}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*${WRAP}\\s*>`,
	'gi'
);
const INVOKE_BLOCK_RE = new RegExp(
	`<\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\s*\\/\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*invoke\\s*>`,
	'gi'
);
const PARAM_RE = new RegExp(
	`<\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*parameter\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>([\\s\\S]*?)<\\s*\\/\\s*${BAR}?\\s*DSML\\s*${BAR}\\s*parameter\\s*>`,
	'gi'
);
/** Stream died mid-marker: an open DSML tag with no closing `>` at the end of the text. */
const DANGLING_RE = new RegExp(`<\\s*${BAR}?\\s*DSML[\\s\\S]*$`, 'i');

const DETECT_RE = new RegExp(`${BAR}\\s*DSML|DSML\\s*${BAR}`, 'i');

function parseParams(body: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const re = new RegExp(PARAM_RE.source, 'gi');
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		const name = m[1];
		const isJson = m[2] === 'false';
		const raw = (m[3] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '');
		if (isJson) {
			try {
				args[name] = JSON.parse(raw.trim());
				continue;
			} catch {
				/* keep as string */
			}
		}
		args[name] = raw;
	}
	return args;
}

export const dsmlParser: GrammarParser = {
	id: 'dsml',
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
			const invokeRe = new RegExp(INVOKE_BLOCK_RE.source, 'gi');
			let im: RegExpExecArray | null;
			let any = false;
			while ((im = invokeRe.exec(bm[1]))) {
				any = true;
				calls.push({
					id: `dsml_${calls.length}`,
					type: 'function',
					function: { name: im[1], arguments: JSON.stringify(parseParams(im[2])) },
				});
			}
			if (any) spans.push([bm.index, bm.index + bm[0].length]);
		}

		calls = requireKnownTool(calls, ctx.toolNames);

		if (!calls.length) {
			// Dangling open marker with no close — strip for hygiene, no calls recovered.
			const dangling = DANGLING_RE.exec(masked);
			if (dangling && !tag('tool_calls').test(masked.slice(0, dangling.index))) {
				const cleanedText = removeSpans(text, [[dangling.index, dangling.index + dangling[0].length]]).trim();
				return { calls: [], cleanedText };
			}
			return { calls: [], cleanedText: text };
		}
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
