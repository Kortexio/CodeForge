/**
 * Llama 3.1 / 3.2 / 3.3 / 4, `<|python_tag|>` prefix (llama3_json / llama3_pythonic). Body is
 * either a JSON object (`{"name": …, "parameters": {…}}`) or a pythonic call
 * (`func_name(key="value", n=1)`). Llama 3.2 sometimes emits the call with no start token at
 * all — that bare-JSON case is already covered by the generic prose-JSON path in
 * `toolCallParsing.ts`, so this parser only handles the tagged form.
 */

import { extractBalancedBraces, maskCodeFences, removeSpans, requireKnownTool } from './safety';
import type { GrammarParseContext, GrammarParseResult, GrammarParser, LiftedToolCall } from './types';

const TAG = '<\\|python_tag\\|>';
const DETECT_RE = new RegExp(TAG, 'i');
const JSON_START_RE = new RegExp(`${TAG}\\s*(\\{)`, 'gi');
const PYTHONIC_RE = new RegExp(`${TAG}\\s*([A-Za-z_][A-Za-z0-9_.]*)\\s*\\(([^)]*)\\)`, 'gi');

export function splitTopLevel(args: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inStr: string | null = null;
	let current = '';
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (inStr) {
			current += ch;
			if (ch === inStr && args[i - 1] !== '\\') inStr = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inStr = ch;
			current += ch;
			continue;
		}
		if (ch === '[' || ch === '(') depth++;
		if (ch === ']' || ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

export function parsePythonLiteral(raw: string): unknown {
	const v = raw.trim();
	if (v === 'True') return true;
	if (v === 'False') return false;
	if (v === 'None') return null;
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	if (v.startsWith('[') && v.endsWith(']')) {
		try {
			return JSON.parse(v.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'));
		} catch {
			return v;
		}
	}
	return v;
}

export function parsePythonicArgs(argsStr: string): Record<string, unknown> | undefined {
	if (!argsStr.trim()) return {};
	const out: Record<string, unknown> = {};
	for (const part of splitTopLevel(argsStr)) {
		const eq = part.indexOf('=');
		if (eq < 0) return undefined;
		const key = part.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
		out[key] = parsePythonLiteral(part.slice(eq + 1));
	}
	return out;
}

export const llamaParser: GrammarParser = {
	id: 'llama',
	detect(text: string): boolean {
		return DETECT_RE.test(text);
	},
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult {
		const masked = maskCodeFences(text);
		if (!DETECT_RE.test(masked)) return { calls: [], cleanedText: text };

		let calls: LiftedToolCall[] = [];
		const spans: Array<[number, number]> = [];

		const jsonRe = new RegExp(JSON_START_RE.source, 'gi');
		let jm: RegExpExecArray | null;
		while ((jm = jsonRe.exec(masked))) {
			const openIndex = jm.index + jm[0].length - 1;
			const obj = extractBalancedBraces(masked, openIndex);
			if (!obj) continue;
			try {
				const parsed = JSON.parse(obj.json) as Record<string, unknown>;
				const name = parsed.name;
				if (typeof name !== 'string') continue;
				const args = (parsed.parameters ?? parsed.arguments ?? {}) as Record<string, unknown>;
				calls.push({ id: `llama_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
				spans.push([jm.index, obj.endIndex]);
			} catch {
				/* leave as text */
			}
		}

		if (!calls.length) {
			const pyRe = new RegExp(PYTHONIC_RE.source, 'gi');
			let pm: RegExpExecArray | null;
			while ((pm = pyRe.exec(masked))) {
				const args = parsePythonicArgs(pm[2]);
				if (!args) continue;
				calls.push({ id: `llama_${calls.length}`, type: 'function', function: { name: pm[1], arguments: JSON.stringify(args) } });
				spans.push([pm.index, pm.index + pm[0].length]);
			}
		}

		calls = requireKnownTool(calls, ctx.toolNames);
		if (!calls.length) return { calls: [], cleanedText: text };
		const cleanedText = removeSpans(text, spans).trim();
		return { calls, cleanedText };
	},
};
