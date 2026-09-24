/**
 * Multi-term lexical scoring for retrieve (pure — no vscode, unit-testable).
 */

export interface LexicalFile {
	path: string;
	text: string;
}

export interface LexicalHit {
	path: string;
	startLine: number;
	text: string;
	score: number;
}

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'are', 'was', 'how', 'what',
	'where', 'when', 'which', 'use', 'uses', 'used', 'does', 'did', 'can',
	'que', 'com', 'para', 'por', 'uma', 'das', 'dos', 'nos', 'nas', 'onde', 'como', 'qual',
]);

export function queryTerms(query: string, max = 8): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
		if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
		seen.add(raw);
		out.push(raw);
		if (out.length >= max) break;
	}
	return out;
}

export function minTermsRequired(termCount: number): number {
	if (termCount <= 2) return 1;
	return Math.max(2, Math.ceil(termCount * 0.35));
}

const DECLARATION =
	/^\s*(#{1,6}\s|(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|record|struct|def|fn|const)\b|(public|private|protected|internal)\s)/;

export function scoreFileText(
	file: LexicalFile,
	terms: string[],
	opts: { phrase?: string; maxHits?: number; contextLines?: number; minTerms?: number } = {}
): LexicalHit[] {
	if (!terms.length || file.text.includes('\u0000')) return [];
	const lines = file.text.split(/\r?\n/);
	const lower = lines.map(l => l.toLowerCase());
	const pathLower = file.path.toLowerCase();
	const pathTerms = new Set(terms.filter(t => pathLower.includes(t)));
	const pathBonus = (pathTerms.size / terms.length) * 0.2;
	const phrase = opts.phrase?.trim().toLowerCase() ?? '';
	const need = opts.minTerms ?? minTermsRequired(terms.length);
	const ctx = opts.contextLines ?? 4;

	const candidates: Array<LexicalHit & { anchor: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		if (!terms.some(t => lower[i].includes(t))) continue;
		const lo = Math.max(0, i - 1);
		const hi = Math.min(lines.length - 1, i + 2);
		let matched = 0;
		let pathOnly = 0;
		for (const t of terms) {
			let inWindow = false;
			for (let j = lo; j <= hi; j++) {
				if (lower[j].includes(t)) {
					inWindow = true;
					break;
				}
			}
			if (inWindow) matched += 1;
			else if (pathTerms.has(t)) pathOnly += 1;
		}
		if (matched + pathOnly < need) continue;
		let score = matched / terms.length + pathBonus;
		if (phrase.length >= 6 && lower[i].includes(phrase)) score += 0.3;
		if (DECLARATION.test(lines[i])) score += 0.1;
		const start = Math.max(0, i - 1);
		const end = Math.min(lines.length, i + ctx + 1);
		candidates.push({
			path: file.path,
			startLine: start + 1,
			text: lines.slice(start, end).join('\n'),
			score,
			anchor: i,
		});
	}

	candidates.sort((a, b) => b.score - a.score || a.anchor - b.anchor);
	const picked: Array<LexicalHit & { anchor: number }> = [];
	for (const c of candidates) {
		if (picked.some(p => Math.abs(p.anchor - c.anchor) <= ctx * 2)) continue;
		picked.push(c);
		if (picked.length >= (opts.maxHits ?? 2)) break;
	}
	return picked.map(({ anchor: _anchor, ...hit }) => hit);
}

/** Rank hits across files; relaxes to single-term matches when nothing clears the threshold. */
export function lexicalSearch(files: LexicalFile[], query: string, k: number): LexicalHit[] {
	const terms = queryTerms(query);
	if (!terms.length) return [];
	const run = (minTerms?: number) =>
		files
			.flatMap(f => scoreFileText(f, terms, { phrase: query, minTerms }))
			.sort((a, b) => b.score - a.score);
	let hits = run();
	if (!hits.length && minTermsRequired(terms.length) > 1) {
		hits = run(1);
	}
	return hits.slice(0, k);
}
