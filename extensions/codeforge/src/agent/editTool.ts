/**
 * `edit` tool core: exact old_string → new_string with tolerant match tiers.
 * Pure — the bridge does the file IO.
 *
 * Match order (opencode-inspired):
 * 1. Exact (after CRLF normalization / LF view)
 * 2. Unicode-normalized (smart quotes, dashes, NBSP)
 * 3. Line-wise ignoring trailing whitespace
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

/** Line-wise match ignoring trailing whitespace on each line. */
function findLineOccurrences(content: string, search: string): Match[] {
	const trailingNewline = search.endsWith('\n');
	const expected = search.split('\n');
	if (trailingNewline) expected.pop();
	const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
		.filter(match => match[0] !== '')
		.map(match => {
			const newline = match[0].endsWith('\n');
			const text = newline ? match[0].slice(0, -1) : match[0];
			return {
				start: match.index!,
				end: match.index! + match[0].length,
				text,
				contentEnd: match.index! + text.length - (text.endsWith('\r') ? 1 : 0),
				newline,
			};
		});
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
		const last = actual[actual.length - 1]!;
		if (trailingNewline && !last.newline) return [];
		return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
	});
	return candidates.reduce<Match[]>((result, candidate) => {
		if (result.some(match => match.end > candidate.start && match.start < candidate.end)) return result;
		result.push(candidate);
		return result;
	}, []);
}

function countBefore(positions: number[], offset: number): number {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (positions[middle]! < offset) low = middle + 1;
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
	const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index! - index);
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

	const matches = (exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing).map(match => ({
		start: match.start + countBefore(removed, match.start),
		end: match.end + countBefore(removed, match.end),
	}));

	return {
		matches,
		replace: (match: Match) => {
			const region = source.slice(match.start, match.end);
			const ending = lineEnding(region, fileEnding);
			const lines = replacement.split('\n');
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
	let oldString = stripReadLineNumbers(String(oldStringRaw ?? ''));
	let newString = stripReadLineNumbers(String(newStringRaw ?? ''));
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
		const near = closestLines(fileText, oldString);
		return {
			ok: false,
			error: [
				'old_string was not found in the file. It must match exactly (including whitespace and indentation), or match after Unicode/trailing-whitespace normalization.',
				near.length ? 'Closest lines (copy the exact text from here or read the file again):' : '',
				...near,
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
	const first = chosen[0]!;
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
