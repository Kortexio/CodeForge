/**
 * Context engine — budget allocation, source ranking, assembly.
 */

import { StableFacts, formatStableFactsBlock, normalizeFacts } from '../agent/stableFacts';

export type ContextSourceKind =
	| 'system'
	| 'status'
	| 'wiki_session'
	| 'wiki_project'
	| 'ide'
	| 'retrieve'
	| 'git'
	| 'mcp'
	| 'history'
	| 'facts'
	| 'lessons';

export interface ContextSource {
	kind: ContextSourceKind;
	priority: number;
	content: string;
	tokensEstimate?: number;
}

export interface ContextBudget {
	total: number;
	/** Reserved fractions (sum <= 1). */
	alloc: Partial<Record<ContextSourceKind, number>>;
}

export const DEFAULT_BUDGET: ContextBudget = {
	total: 32768,
	alloc: {
		system: 0.12,
		status: 0.05,
		wiki_session: 0.1,
		wiki_project: 0.1,
		facts: 0.06,
		lessons: 0.06,
		ide: 0.08,
		retrieve: 0.12,
		git: 0.05,
		mcp: 0.04,
		history: 0.22,
	},
};

const RANK: Record<ContextSourceKind, number> = {
	system: 100,
	status: 96,
	wiki_session: 90,
	facts: 88,
	lessons: 92,
	wiki_project: 85,
	ide: 80,
	retrieve: 70,
	git: 60,
	mcp: 50,
	history: 40,
};

export function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / 4);
}

export function charsFor(budget: ContextBudget, kind: ContextSourceKind): number {
	const frac = budget.alloc[kind] ?? 0.05;
	return Math.max(500, Math.floor(budget.total * frac * 4));
}

export function rankSources(sources: ContextSource[]): ContextSource[] {
	return [...sources].sort((a, b) => {
		const pa = a.priority || RANK[a.kind] || 0;
		const pb = b.priority || RANK[b.kind] || 0;
		if (pb !== pa) return pb - pa;
		// Prefer fresher / longer content when priority ties (rough recency proxy).
		return (b.content?.length || 0) - (a.content?.length || 0);
	});
}

export function assembleContext(
	sources: ContextSource[],
	budget: ContextBudget = DEFAULT_BUDGET
): { markdown: string; usedTokens: number; included: ContextSourceKind[] } {
	const ranked = rankSources(sources.filter(s => s.content.trim()));
	const parts: string[] = [];
	const included: ContextSourceKind[] = [];
	let used = 0;
	const hardCap = Math.floor(budget.total * 0.85);

	for (const src of ranked) {
		const maxChars = charsFor(budget, src.kind);
		let body = src.content.trim();
		if (body.length > maxChars) {
			body = body.slice(0, maxChars) + `\n…[${src.kind} truncated]`;
		}
		const tok = estimateTokens(body);
		if (used + tok > hardCap && included.length > 0) {
			continue;
		}
		parts.push(body);
		included.push(src.kind);
		used += tok;
	}

	return {
		markdown: parts.join('\n\n'),
		usedTokens: used,
		included,
	};
}

export function factsSource(facts?: StableFacts): ContextSource | null {
	const block = formatStableFactsBlock(normalizeFacts(facts));
	if (!block) return null;
	return { kind: 'facts', priority: RANK.facts, content: block };
}
