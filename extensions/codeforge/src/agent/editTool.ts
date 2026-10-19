/**
 * `edit` tool core: exact old_string → new_string with tolerant match tiers.
 * Pure — the bridge does the file IO.
 *
 * Match order (opencode-inspired):
 * 1. Exact (after CRLF normalization / LF view)
 * 2. Unicode-normalized (smart quotes, dashes, NBSP)
 * 3. Line-wise ignoring trailing whitespace
 * 4. Indent-tolerant (tabs vs spaces / indent depth) when exactly one match
 */

export type EditResult =
	| { ok: true; text: string; count: number; firstLine: number; alreadyApplied?: boolean }
	| { ok: false; error: string };

interface Match {
	start: number;
	end: number;
}

const CRLF = '\r\n';

/** `  12|code` prefixes copied from read output. */
export function stripReadLineNumbers(s: string): string {
	const lines = s.split('\n');
	const nonempty = lines.filter(l => l.trim());
	if (!nonempty.length) return s;
	const numbered = nonempty.every(l => /^\s*\d+\|/.test(l));
	return numbered ? lines.map(l => l.replace(/^\s*\d+\|/, '')).join('\n') : s;
}

/** Typographic quote / dash / space variants → ASCII. */
export function normalizeForMatch(value: string): string {
	return value
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function bigrams(s: string): Map<string, number> {
	const m = new Map<string, number>();
	const t = s.replace(/\s+/g, ' ').trim().toLowerCase();
	for (let i = 0; i < t.length - 1; i++) {
		const g = t.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return m;
}

function similarity(a: string, b: string): number {
	const A = bigrams(a);
	const B = bigrams(b);
	let inter = 0;
	let total = 0;
	for (const [g, n] of A) {
		inter += Math.min(n, B.get(g) ?? 0);
		total += n;
	}
	for (const n of B.values()) total += n;
	return total ? (2 * inter) / total : 0;
}

/** The 3 file lines closest to the first meaningful line of old_string. */
export function closestLines(fileText: string, oldString: string, n = 3): string[] {
	const probe = oldString.split('\n').find(l => l.trim().length >= 3)?.trim() ?? oldString.trim();
	if (!probe) return [];
	return fileText
		.split('\n')
		.map((line, i) => ({ line: line.replace(/\r$/, ''), i, s: similarity(probe, line) }))
		.filter(x => x.line.trim())
		.sort((a, b) => b.s - a.s)
		.slice(0, n)
		.sort((a, b) => a.i - b.i)
		.map(x => `${String(x.i + 1).padStart(4, ' ')}|${x.line}`);
}

/**
 * Numbered window around the best-matching line (read-tool format: `  N|text`).
 * Includes `radius` lines before the match and after the old_string span.
 */
export function closestWindow(fileText: string, oldString: string, radius = 15): string {
	const lines = fileText.split(/\r?\n/);
	if (!lines.length) return '';
	const probe =
		oldString.split('\n').find(l => l.trim().length >= 3)?.trim() ?? oldString.trim();
	let bestIdx = 0;
	if (probe) {
		let bestScore = -1;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].replace(/\r$/, '');
			if (!line.trim()) continue;
			const s = similarity(probe, line);
			if (s > bestScore) {
				bestScore = s;
				bestIdx = i;
			}
		}
	}
	const span = Math.max(1, oldString.split('\n').length);
	const from = Math.max(0, bestIdx - radius);
	const to = Math.min(lines.length - 1, bestIdx + span - 1 + radius);
	const out: string[] = [];
	for (let i = from; i <= to; i++) {
		out.push(`${String(i + 1).padStart(4, ' ')}|${lines[i].replace(/\r$/, '')}`);
	}
	return out.join('\n');
}

/** First `limit` lines of a file in read-tool numbered format. */
export function numberedExcerpt(fileText: string, limit = 120): string {
	const lines = fileText.split(/\r?\n/);
	const end = Math.min(lines.length, Math.max(1, limit));
	const out: string[] = [];
	for (let i = 0; i < end; i++) {
		out.push(`${String(i + 1).padStart(4, ' ')}|${lines[i].replace(/\r$/, '')}`);
	}
	return out.join('\n');
}

function findOccurrences(hay: string, needle: string): Match[] {
	const result: Match[] = [];
	if (!needle) return result;
	let from = 0;
	for (;;) {
		const idx = hay.indexOf(needle, from);
		if (idx < 0) return result;
		result.push({ start: idx, end: idx + needle.length });
		from = idx + needle.length;
	}
}

/** Split content into line records with offsets (LF view). */
function lineRecords(content: string): Array<{
	start: number;
	end: number;
	text: string;
	contentEnd: number;
	newline: boolean;
}> {
	return [...content.matchAll(/[^\n]*(?:\n|$)/g)]
		.filter(match => match[0] !== '')
		.map(match => {
			const newline = match[0].endsWith('\n');
			const text = newline ? match[0].slice(0, -1) : match[0];
			return {
				start: match.index,
				end: match.index + match[0].length,
				text,
				contentEnd: match.index + text.length - (text.endsWith('\r') ? 1 : 0),
				newline,
			};
		});
}

/** Line-wise match ignoring trailing whitespace on each line. */
function findLineOccurrences(content: string, search: string): Match[] {
	const trailingNewline = search.endsWith('\n');
	const expected = search.split('\n');
	if (trailingNewline) expected.pop();
	const lines = lineRecords(content);
	const candidates = lines.flatMap((line, index) => {
		const actual = lines.slice(index, index + expected.length);
		if (actual.length !== expected.length) return [];
		if (
			!actual.every(
				(item, lineIndex) =>
					normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd())
			)
		)
			return [];
		const last = actual[actual.length - 1];
		if (trailingNewline && !last.newline) return [];
		return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
	});
	return candidates.reduce<Match[]>((result, candidate) => {
		if (result.some(match => match.end > candidate.start && match.start < candidate.end)) return result;
		result.push(candidate);
		return result;
	}, []);
}

/**
 * Line-wise match ignoring leading indentation (tabs vs spaces / depth).
 * Only used when it yields exactly one match.
 */
function findIndentTolerantOccurrences(content: string, search: string): Match[] {
	const trailingNewline = search.endsWith('\n');
	const expected = search.split('\n');
	if (trailingNewline) expected.pop();
	if (!expected.length || !expected.some(l => l.trim())) return [];
	const lines = lineRecords(content);
	const candidates = lines.flatMap((line, index) => {
		const actual = lines.slice(index, index + expected.length);
		if (actual.length !== expected.length) return [];
		if (
			!actual.every(
				(item, lineIndex) =>
					normalizeForMatch(item.text.trimStart().trimEnd()) ===
					normalizeForMatch(expected[lineIndex].trimStart().trimEnd())
			)
		)
			return [];
		const last = actual[actual.length - 1];
		if (trailingNewline && !last.newline) return [];
		return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
	});
	return candidates.reduce<Match[]>((result, candidate) => {
		if (result.some(match => match.end > candidate.start && match.start < candidate.end)) return result;
		result.push(candidate);
		return result;
	}, []);
}

function leadingWs(line: string): string {
	return (/^[\t ]*/.exec(line) || [''])[0];
}

function expandTabs(indent: string, tabWidth = 4): string {
	return indent.replace(/\t/g, ' '.repeat(tabWidth));
}

function detectIndentUnit(fileLines: string[]): { unit: string; usesTabs: boolean } {
	const indents = fileLines.map(leadingWs).filter(i => i.length > 0);
	if (indents.some(i => i.includes('\t'))) {
		return { unit: '\t', usesTabs: true };
	}
	const lengths = indents.map(i => expandTabs(i).length).filter(n => n > 0);
	if (!lengths.length) return { unit: '  ', usesTabs: false };
	let g = lengths[0];
	for (const n of lengths) {
		let a = g;
		let b = n;
		while (b) {
			const t = b;
			b = a % b;
			a = t;
		}
		g = a;
	}
	const width = g >= 2 && g <= 8 ? g : 2;
	return { unit: ' '.repeat(width), usesTabs: false };
}

/**
 * Re-indent new_string so its structure matches old_string but base indent matches the file region.
 */
export function reindentToFile(fileRegion: string, oldString: string, newString: string): string {
	const fileLines = fileRegion.replaceAll(CRLF, '\n').split('\n');
	const oldLines = oldString.replaceAll(CRLF, '\n').split('\n');
	const newLines = newString.replaceAll(CRLF, '\n').split('\n');
	const { usesTabs } = detectIndentUnit(fileLines);

	const oldBaseSpaces = expandTabs(leadingWs(oldLines.find(l => l.trim()) ?? '')).length;
	const fileBaseSpaces = expandTabs(leadingWs(fileLines.find(l => l.trim()) ?? '')).length;

	return newLines
		.map(line => {
			if (!line.trim()) return '';
			const lineSpaces = expandTabs(leadingWs(line)).length;
			const targetSpaces = Math.max(0, fileBaseSpaces + (lineSpaces - oldBaseSpaces));
			const prefix = usesTabs
				? '\t'.repeat(Math.round(targetSpaces / 4))
				: ' '.repeat(targetSpaces);
			return prefix + line.trimStart();
		})
		.join('\n');
}

function countBefore(positions: number[], offset: number): number {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (positions[middle] < offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

function lineEnding(text: string, fallback: string): string {
	const crlfCount = text.split(CRLF).length - 1;
	const lfCount = text.split('\n').length - 1 - crlfCount;
	if (crlfCount === lfCount) return fallback;
	return crlfCount > lfCount ? CRLF : '\n';
}

/**
 * Match against the LF view (what Read shows), then map offsets back to source
 * so CRLF / mixed endings neither block matches nor leak into untouched regions.
 */
function matchView(source: string, oldString: string, newString: string): {
	matches: Match[];
	replace: (match: Match) => string;
} {
	const view = source.replaceAll(CRLF, '\n');
	const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index);
	const fileEnding = lineEnding(source, '\n');
	const search = oldString.replaceAll(CRLF, '\n');
	const replacement = newString.replaceAll(CRLF, '\n');

	const exact = findOccurrences(view, search);
	const unicode =
		exact.length > 0
			? []
			: findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
	const trailing =
		exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search);
	const indentRaw =
		exact.length > 0 || unicode.length > 0 || trailing.length > 0
			? []
			: findIndentTolerantOccurrences(view, search);
	/** Indent tier only when it yields exactly one match. */
	const indent = indentRaw.length === 1 ? indentRaw : [];
	const useIndent = indent.length === 1;

	const viewMatches = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing.length > 0 ? trailing : indent;

	const matches = viewMatches.map(match => ({
		start: match.start + countBefore(removed, match.start),
		end: match.end + countBefore(removed, match.end),
	}));

	return {
		matches,
		replace: (match: Match) => {
			const region = source.slice(match.start, match.end);
			const ending = lineEnding(region, fileEnding);
			let repl = replacement;
			if (useIndent) {
				const regionView = region.replaceAll(CRLF, '\n');
				repl = reindentToFile(regionView, search, replacement);
			}
			const lines = repl.split('\n');
			return lines
				.map((line, i) => (i === lines.length - 1 ? line : line + ending))
				.join('');
		},
	};
}

export function applyEdit(
	fileText: string,
	oldStringRaw: string,
	newStringRaw: string,
	replaceAll = false
): EditResult {
	const oldString = stripReadLineNumbers(String(oldStringRaw ?? ''));
	const newString = stripReadLineNumbers(String(newStringRaw ?? ''));
	if (!oldString) {
		return {
			ok: false,
			error:
				'old_string is empty. To create a file use write; to change one, copy the exact text to replace.',
		};
	}
	if (oldString === newString) {
		return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
	}

	const { matches, replace } = matchView(fileText, oldString, newString);
	const count = matches.length;

	if (count === 0) {
		// Model often invents a broken old_string when the desired new_string is already on disk.
		const view = fileText.replaceAll(CRLF, '\n');
		const neu = newString.replaceAll(CRLF, '\n');
		const already =
			view.includes(neu) ||
			normalizeForMatch(view).includes(normalizeForMatch(neu));
		if (already) {
			const idx = view.indexOf(neu);
			const firstLine =
				idx >= 0 ? view.slice(0, idx).split('\n').length : 1;
			return {
				ok: true,
				text: fileText,
				count: 0,
				firstLine,
				alreadyApplied: true,
			};
		}
		const near = closestWindow(fileText, oldString);
		return {
			ok: false,
			error: [
				'old_string was not found in the file. It must match exactly (including whitespace and indentation), or match after Unicode/trailing-whitespace/indent-tolerant normalization.',
				near ? 'Closest window (copy the exact text from here or read the file again):' : '',
				near,
			]
				.filter(Boolean)
				.join('\n'),
		};
	}
	if (count > 1 && !replaceAll) {
		const lines = matches.slice(0, 5).map(m => fileText.slice(0, m.start).split('\n').length);
		return {
			ok: false,
			error: `old_string matches ${count} places (lines ${lines.join(', ')}). Add surrounding lines to make it unique, or set replace_all=true.`,
		};
	}

	const chosen = replaceAll ? matches : matches.slice(0, 1);
	const first = chosen[0];
	const firstLine = fileText.slice(0, first.start).split('\n').length;
	let text = fileText;
	for (const match of [...chosen].reverse()) {
		text = `${text.slice(0, match.start)}${replace(match)}${text.slice(match.end)}`;
	}
	if (text === fileText) {
		return { ok: false, error: 'No changes to apply: the edit leaves the file unchanged.' };
	}
	return { ok: true, text, count: chosen.length, firstLine };
}

/** Numbered excerpt around the edit so the model sees the result without another read. */
export function excerptAround(text: string, firstLine: number, newString: string, context = 3): string {
	const lines = text.split(/\r?\n/);
	const span = Math.max(1, newString.split('\n').length);
	const from = Math.max(1, firstLine - context);
	const to = Math.min(lines.length, firstLine + span - 1 + context);
	const fmt = (n: number) => `${String(n).padStart(4, ' ')}|${lines[n - 1]}`;
	const out: string[] = [];
	if (to - from > 40) {
		for (let n = from; n < from + 20; n++) out.push(fmt(n));
		out.push(`…[${to - from - 29} lines omitted]`);
		for (let n = to - 9; n <= to; n++) out.push(fmt(n));
		return out.join('\n');
	}
	for (let n = from; n <= to; n++) out.push(fmt(n));
	return out.join('\n');
}
