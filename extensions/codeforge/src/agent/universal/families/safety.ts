/**
 * Shared safety gates for grammar parsers (pi-tool-repair survey, "Design implications").
 * Every family parser is built on top of these so the travas are uniform, not per-parser.
 */

import type { LiftedToolCall } from './types';

/** Fenced code block spans (``` … ```), so a marker shown as an example is not executed. */
export function codeFenceRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const re = /```[\s\S]*?```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
	return ranges;
}

/**
 * Blank the interior of fenced code blocks (keep newlines, same length) so family regexes
 * run safely against the result: a match found here is guaranteed to be outside any fence,
 * and its indices/groups are identical to the original text (masking never shifts positions).
 */
export function maskCodeFences(text: string): string {
	return text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Only keep calls whose name is one of the tools actually sent this turn. */
export function requireKnownTool(calls: LiftedToolCall[], toolNames: ReadonlySet<string>): LiftedToolCall[] {
	if (!toolNames.size) return calls;
	return calls.filter((c) => toolNames.has(c.function.name));
}

/** Remove a slice of the original text (by index/length found against the masked text). */
export function removeSpan(text: string, start: number, length: number): string {
	return text.slice(0, start) + text.slice(start + length);
}

/**
 * Remove spans in descending order so earlier indices stay valid while later ones are cut.
 */
export function removeSpans(text: string, spans: Array<[number, number]>): string {
	const sorted = [...spans].sort((a, b) => b[0] - a[0]);
	let out = text;
	for (const [start, end] of sorted) {
		out = removeSpan(out, start, end - start);
	}
	return out;
}

/**
 * Extract one balanced `{ … }` object starting at `text[openIndex] === '{'`, honoring quoted
 * strings (so a `}` inside a string value does not close early). Returns the substring
 * including both braces and the index right after the closing brace, or undefined if the
 * object never closes.
 */
export function extractBalancedBraces(text: string, openIndex: number): { json: string; endIndex: number } | undefined {
	return extractBalanced(text, openIndex, '{', '}');
}

/** Same as `extractBalancedBraces`, for a `[ … ]` array. */
export function extractBalancedBrackets(text: string, openIndex: number): { json: string; endIndex: number } | undefined {
	return extractBalanced(text, openIndex, '[', ']');
}

function extractBalanced(
	text: string,
	openIndex: number,
	open: string,
	close: string
): { json: string; endIndex: number } | undefined {
	if (text[openIndex] !== open) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return { json: text.slice(openIndex, i + 1), endIndex: i + 1 };
		}
	}
	return undefined;
}
