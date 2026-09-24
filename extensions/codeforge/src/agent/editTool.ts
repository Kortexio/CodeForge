/**
 * `edit` tool core: exact old_string → new_string replacement with useful errors.
 * Pure — the bridge does the file IO.
 */

export type EditResult =
	| { ok: true; text: string; count: number; firstLine: number }
	| { ok: false; error: string };

/** `  12|code` prefixes copied from read output. */
function stripReadLineNumbers(s: string): string {
	const lines = s.split('\n');
	const numbered = lines.filter(l => l.trim()).every(l => /^\s*\d+\|/.test(l));
	return numbered ? lines.map(l => l.replace(/^\s*\d+\|/, '')).join('\n') : s;
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

function countOccurrences(hay: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const idx = hay.indexOf(needle, from);
		if (idx < 0) return count;
		count++;
		from = idx + needle.length;
	}
}

export function applyEdit(
	fileText: string,
	oldStringRaw: string,
	newStringRaw: string,
	replaceAll = false
): EditResult {
	let oldString = stripReadLineNumbers(String(oldStringRaw ?? ''));
	let newString = String(newStringRaw ?? '');
	if (!oldString) {
		return { ok: false, error: 'old_string is empty. To create a file use write; to change one, copy the exact text to replace.' };
	}
	if (oldString === newString) {
		return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
	}
	const crlf = fileText.includes('\r\n');
	if (crlf) {
		oldString = oldString.replace(/\r?\n/g, '\r\n');
		newString = newString.replace(/\r?\n/g, '\r\n');
	}
	let count = countOccurrences(fileText, oldString);
	if (count === 0) {
		// Tolerate trailing-whitespace drift on each line (common when models retype code).
		const pattern = oldString
			.split(/\r?\n/)
			.map(l => l.trimEnd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*')
			.join('\\r?\\n');
		const re = new RegExp(pattern, 'g');
		const matches = [...fileText.matchAll(re)];
		if (matches.length === 1 || (matches.length > 1 && replaceAll)) {
			oldString = matches[0][0];
			count = countOccurrences(fileText, oldString);
		}
	}
	if (count === 0) {
		const near = closestLines(fileText, oldString);
		return {
			ok: false,
			error: [
				'old_string was not found in the file.',
				near.length ? 'Closest lines (copy the exact text from here or read the file again):' : '',
				...near,
			]
				.filter(Boolean)
				.join('\n'),
		};
	}
	if (count > 1 && !replaceAll) {
		const lines: number[] = [];
		let from = 0;
		for (let k = 0; k < Math.min(count, 5); k++) {
			const idx = fileText.indexOf(oldString, from);
			lines.push(fileText.slice(0, idx).split('\n').length);
			from = idx + oldString.length;
		}
		return {
			ok: false,
			error: `old_string matches ${count} places (lines ${lines.join(', ')}). Add surrounding lines to make it unique, or set replace_all=true.`,
		};
	}
	const firstIdx = fileText.indexOf(oldString);
	const firstLine = fileText.slice(0, firstIdx).split('\n').length;
	const text = replaceAll ? fileText.split(oldString).join(newString) : fileText.replace(oldString, () => newString);
	return { ok: true, text, count: replaceAll ? count : 1, firstLine };
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
