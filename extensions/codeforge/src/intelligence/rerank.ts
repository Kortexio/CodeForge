/**
 * Pure rerank helpers for retrieve (no vscode / no network).
 */

export interface RerankCandidate {
	path: string;
	startLine: number;
	endLine?: number;
	symbol?: string;
	text: string;
}

export function buildRerankPrompt(
	query: string,
	candidates: RerankCandidate[],
	keep: number
): string {
	const lines = candidates.map((c, i) => {
		const end = c.endLine ?? c.startLine;
		const sym = c.symbol ? ` ${c.symbol}` : '';
		const preview = c.text.replace(/\s+/g, ' ').slice(0, 180);
		return `[${i}] ${c.path}:${c.startLine}-${end}${sym}\n${preview}`;
	});
	return [
		'Select the most relevant code snippets for the query.',
		`Query: ${query}`,
		`Return ONLY JSON: {"keep":[<up to ${keep} indices>]}`,
		'Candidates:',
		...lines,
	].join('\n');
}

/**
 * Parse {"keep":[...]} from model output. Falls back to [] on invalid input.
 */
export function parseKeepIndices(raw: string, candidateCount: number): number[] {
	if (!raw?.trim() || candidateCount <= 0) return [];
	const text = raw.trim();
	let jsonStr = text;
	const fence = text.match(/\{[\s\S]*\}/);
	if (fence) jsonStr = fence[0];
	try {
		const parsed = JSON.parse(jsonStr) as { keep?: unknown };
		if (!Array.isArray(parsed.keep)) return [];
		const seen = new Set<number>();
		const out: number[] = [];
		for (const v of parsed.keep) {
			const n = typeof v === 'number' ? v : Number(v);
			if (!Number.isInteger(n) || n < 0 || n >= candidateCount || seen.has(n)) continue;
			seen.add(n);
			out.push(n);
		}
		return out;
	} catch {
		return [];
	}
}
