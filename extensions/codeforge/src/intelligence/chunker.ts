/**
 * Pure code chunker for workspace index (no vscode).
 * Prefers symbol ranges; falls back to blank-line blocks with overlap.
 */

export interface SymbolSpan {
	name: string;
	kind?: string;
	startLine: number;
	endLine: number;
	/** Parent path segments for nested symbols, e.g. ["CartService"]. */
	parents?: string[];
}

export interface CodeChunk {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	symbol?: string;
	header: string;
}

const MIN_LINES = 20;
const MAX_LINES = 120;
const FALLBACK_OVERLAP = 8;

export function chunkFile(
	path: string,
	text: string,
	symbols?: SymbolSpan[]
): CodeChunk[] {
	const lines = text.split(/\r?\n/);
	if (!lines.length || (lines.length === 1 && lines[0] === '')) {
		return [];
	}
	if (symbols?.length) {
		const fromSymbols = chunkBySymbols(path, lines, symbols);
		if (fromSymbols.length) return fromSymbols;
	}
	return chunkByBlankLines(path, lines);
}

function chunkBySymbols(path: string, lines: string[], symbols: SymbolSpan[]): CodeChunk[] {
	const sorted = [...symbols]
		.filter(s => s.endLine >= s.startLine && s.startLine >= 1)
		.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

	const chunks: CodeChunk[] = [];
	for (const s of sorted) {
		const span = s.endLine - s.startLine + 1;
		if (span < 3) continue;
		const symbolPath = [...(s.parents ?? []), s.name].join('.');
		if (span <= MAX_LINES) {
			chunks.push(makeChunk(path, lines, s.startLine, s.endLine, symbolPath));
			continue;
		}
		// Large symbol: split into overlapping windows.
		for (let start = s.startLine; start <= s.endLine; start += MAX_LINES - FALLBACK_OVERLAP) {
			const end = Math.min(s.endLine, start + MAX_LINES - 1);
			chunks.push(makeChunk(path, lines, start, end, symbolPath));
			if (end >= s.endLine) break;
		}
	}
	return dedupeChunks(chunks);
}

function chunkByBlankLines(path: string, lines: string[]): CodeChunk[] {
	const blocks: Array<{ start: number; end: number }> = [];
	let start = 1;
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const blank = !lines[i].trim();
		const atEnd = i === lines.length - 1;
		if (blank || atEnd) {
			const end = atEnd && !blank ? lineNo : lineNo - 1;
			if (end >= start) {
				blocks.push({ start, end });
			}
			start = lineNo + 1;
		}
	}
	if (!blocks.length) {
		blocks.push({ start: 1, end: lines.length });
	}

	const merged: Array<{ start: number; end: number }> = [];
	let cur = { ...blocks[0] };
	for (let i = 1; i < blocks.length; i++) {
		const b = blocks[i];
		const curSpan = cur.end - cur.start + 1;
		const nextSpan = b.end - b.start + 1;
		if (curSpan < MIN_LINES || (curSpan + nextSpan <= MAX_LINES && nextSpan < MIN_LINES)) {
			cur.end = b.end;
		} else if (curSpan > MAX_LINES) {
			// Flush oversized current in windows.
			for (let s = cur.start; s <= cur.end; s += MAX_LINES - FALLBACK_OVERLAP) {
				const e = Math.min(cur.end, s + MAX_LINES - 1);
				merged.push({ start: s, end: e });
				if (e >= cur.end) break;
			}
			cur = { ...b };
		} else {
			merged.push(cur);
			cur = { ...b };
		}
	}
	const curSpan = cur.end - cur.start + 1;
	if (curSpan > MAX_LINES) {
		for (let s = cur.start; s <= cur.end; s += MAX_LINES - FALLBACK_OVERLAP) {
			const e = Math.min(cur.end, s + MAX_LINES - 1);
			merged.push({ start: s, end: e });
			if (e >= cur.end) break;
		}
	} else {
		merged.push(cur);
	}

	return merged
		.filter(b => b.end >= b.start)
		.map(b => makeChunk(path, lines, b.start, b.end));
}

function makeChunk(
	path: string,
	lines: string[],
	startLine: number,
	endLine: number,
	symbol?: string
): CodeChunk {
	const start = Math.max(1, startLine);
	const end = Math.min(lines.length, Math.max(start, endLine));
	const body = lines.slice(start - 1, end).join('\n');
	const header = symbol ? `${path} > ${symbol}` : `${path}:${start}-${end}`;
	return {
		path,
		startLine: start,
		endLine: end,
		symbol,
		header,
		text: `${header}\n${body}`,
	};
}

function dedupeChunks(chunks: CodeChunk[]): CodeChunk[] {
	const seen = new Set<string>();
	const out: CodeChunk[] = [];
	for (const c of chunks) {
		const key = `${c.path}:${c.startLine}:${c.endLine}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(c);
	}
	return out;
}
