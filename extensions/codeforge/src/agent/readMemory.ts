/**
 * Soft read memory: a re-read of lines already returned in this run is answered from memory
 * (same content, marked as already in context) instead of being refused or re-fetched.
 * Pure — no vscode.
 */

/** Canonical relative path key (slash-normalized, lowercased). */
export function canonicalizePathKey(raw: string): string {
	return String(raw || '')
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\.\//, '')
		.toLowerCase();
}

/** Parse `FILE path lines a-b/total` from read tool output. */
export function parseReadCoverage(output: string): { start: number; end: number; total: number } | undefined {
	const m = /^FILE .+ lines (\d+)-(\d+)\/(\d+)/m.exec(output);
	if (!m) return undefined;
	return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

/** Numbered lines (`  12|text`) from a read output. */
export function parseNumberedLines(output: string): Map<number, string> {
	const lines = new Map<number, string>();
	for (const raw of String(output || '').split('\n')) {
		const m = /^\s*(\d+)\|(.*)$/.exec(raw);
		if (m) lines.set(Number(m[1]), m[2]);
	}
	return lines;
}

/**
 * Rebuild the requested window from cached read outputs (keys `readwin:<path>@<start>@<limit>`).
 * Returns undefined when any requested line is missing — the caller then reads from disk.
 */
export function rememberedReadWindow(
	cache: Map<string, string>,
	pathKeys: string[],
	start: number,
	limit: number
): string | undefined {
	for (const k of pathKeys) {
		const exact = cache.get(`readwin:${k}@${start}@${limit}`);
		if (exact) return exact;
	}
	const known = new Map<number, string>();
	let total = 0;
	let label = '';
	for (const [key, value] of cache) {
		if (!pathKeys.some(k => key.startsWith(`readwin:${k}@`))) continue;
		const cov = parseReadCoverage(value);
		if (cov) {
			total = Math.max(total, cov.total);
			label ||= /^FILE (.+) lines /m.exec(value)?.[1] ?? '';
		}
		for (const [n, text] of parseNumberedLines(value)) known.set(n, text);
	}
	if (!total || !known.size) return undefined;
	const end = Math.min(total, start + limit - 1);
	if (start > end) return undefined;
	const body: string[] = [];
	for (let n = start; n <= end; n++) {
		const text = known.get(n);
		if (text === undefined) return undefined;
		body.push(`${String(n).padStart(4, ' ')}|${text}`);
	}
	const tail = end < total ? `\n(more: startLine=${end + 1})` : `\n(end of file — ${total} lines)`;
	return `FILE ${label || pathKeys[0]} lines ${start}-${end}/${total}\n${body.join('\n')}${tail}`;
}

/** Drop remembered reads/lists for paths that changed on disk. */
export function invalidatePaths(
	cache: Map<string, string>,
	readPathsSeen: Set<string>,
	readMaxEnd: Map<string, number>,
	keys: Iterable<string>
): void {
	for (const k of keys) {
		readPathsSeen.delete(k);
		readMaxEnd.delete(k);
		for (const cacheKey of [...cache.keys()]) {
			if (cacheKey.startsWith(`readwin:${k}@`) || cacheKey === `list:${k}`) {
				cache.delete(cacheKey);
			}
		}
	}
}

/** Path aliases for card-driven repos where `C01.md` and `docs/C01.md` are the same file. */
export function readAliasesFor(pathKey: string): string[] {
	if (!pathKey) return [];
	const alt = pathKey.startsWith('docs/') ? pathKey.slice(5) : `docs/${pathKey}`;
	return [pathKey, alt].filter((v, i, a) => a.indexOf(v) === i);
}
