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
	| 'lessons'
	| 'extension';

export interface ContextItem {
	text: string;
	priority: number;
}

export interface ContextSource {
	kind: ContextSourceKind;
	priority: number;
	content: string;
	tokensEstimate?: number;
	/** Optional atomic units; low-priority items are dropped whole instead of truncating mid-text. */
	items?: ContextItem[];
	/** When true, never truncate this source's content (status / where we stopped). */
	noTruncate?: boolean;
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
		extension: 0.08,
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
	extension: 75,
	retrieve: 70,
	git: 60,
	mcp: 50,
	history: 40,
};

/** Kinds that receive leftover budget after others fit. */
const LEFTOVER_KINDS: ContextSourceKind[] = ['retrieve', 'history'];

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
		return (b.content?.length || 0) - (a.content?.length || 0);
	});
}

function bodyFromSource(src: ContextSource, maxChars: number): string {
	if (src.items?.length) {
		const sorted = [...src.items].sort((a, b) => b.priority - a.priority);
		const parts: string[] = [];
		let used = 0;
		for (const item of sorted) {
			const t = item.text.trim();
			if (!t) continue;
			if (used + t.length + 2 > maxChars && parts.length > 0) continue;
			if (t.length > maxChars && parts.length === 0) {
				parts.push(t.slice(0, maxChars) + `\n…[${src.kind} truncated]`);
				used = maxChars;
				break;
			}
			parts.push(t);
			used += t.length + 2;
		}
		return parts.join('\n\n');
	}
	let body = src.content.trim();
	if (src.noTruncate) return body;
	if (body.length > maxChars) {
		body = body.slice(0, maxChars) + `\n…[${src.kind} truncated]`;
	}
	return body;
}

export function assembleContext(
	sources: ContextSource[],
	budget: ContextBudget = DEFAULT_BUDGET
): { markdown: string; usedTokens: number; included: ContextSourceKind[] } {
	const ranked = rankSources(sources.filter(s => s.content.trim() || s.items?.length));
	const parts: string[] = [];
	const included: ContextSourceKind[] = [];
	let used = 0;
	const hardCap = Math.floor(budget.total * 0.85);
	const usedCharsByKind = new Map<ContextSourceKind, number>();

	for (const src of ranked) {
		const maxChars = charsFor(budget, src.kind);
		const body = bodyFromSource(src, maxChars);
		if (!body.trim()) continue;
		const tok = estimateTokens(body);
		if (used + tok > hardCap && included.length > 0) {
			continue;
		}
		parts.push(body);
		included.push(src.kind);
		used += tok;
		usedCharsByKind.set(src.kind, (usedCharsByKind.get(src.kind) ?? 0) + body.length);
	}

	// Leftover budget → retrieve / history: try to expand itemized sources already included.
	const leftoverTokens = hardCap - used;
	if (leftoverTokens > 200) {
		for (const kind of LEFTOVER_KINDS) {
			const src = ranked.find(s => s.kind === kind && s.items?.length);
			if (!src || !included.includes(kind)) continue;
			const baseMax = charsFor(budget, kind);
			const extraChars = leftoverTokens * 4;
			const expanded = bodyFromSource(src, baseMax + extraChars);
			const idx = included.indexOf(kind);
			if (idx >= 0 && expanded.length > parts[idx].length) {
				const delta = estimateTokens(expanded) - estimateTokens(parts[idx]);
				if (used + delta <= hardCap) {
					parts[idx] = expanded;
					used += delta;
				}
			}
		}
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
