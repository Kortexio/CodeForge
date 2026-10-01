/**
 * Unified skill catalog + body lookup for the on-demand `skill` tool.
 */

import { getGovernanceStore } from '../governance/governanceStore';
import { getSkillsRules, type SkillDoc } from './skillsRulesLoader';

function clipText(s: string, max: number): string {
	const t = s.trim();
	return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

export interface SkillCatalogEntry {
	id: string;
	title: string;
	description: string;
}

function norm(s: string): string {
	return s.trim().toLowerCase();
}

/** Catalog lines for the skill tool description (id/title/description only). */
export function listSkillCatalog(): SkillCatalogEntry[] {
	const seen = new Set<string>();
	const out: SkillCatalogEntry[] = [];

	const push = (id: string, title: string, description?: string) => {
		const key = norm(id) || norm(title);
		if (!key || seen.has(key)) return;
		seen.add(key);
		seen.add(norm(title));
		out.push({
			id,
			title,
			description: (description || '').trim().slice(0, 160),
		});
	};

	try {
		for (const s of getGovernanceStore().getState().skills.filter(x => x.enabled)) {
			push(s.id, s.title, s.description);
		}
	} catch {
		/* ignore */
	}

	try {
		for (const s of getSkillsRules().listSkills()) {
			push(s.id, s.title, s.description);
		}
	} catch {
		/* ignore */
	}

	return out;
}

export function formatSkillCatalogForTool(maxChars = 1800): string {
	const entries = listSkillCatalog();
	if (!entries.length) return '(no skills registered)';
	const lines = entries.map(e => {
		const desc = e.description ? ` — ${e.description}` : '';
		return `- ${e.id}: ${e.title}${desc}`;
	});
	let text = lines.join('\n');
	if (text.length > maxChars) {
		text = text.slice(0, maxChars - 1) + '…';
	}
	return text;
}

/** Resolve skill body by id or title (governance first, then disk). */
export function resolveSkillBody(name: string): { title: string; body: string } | null {
	const q = norm(name);
	if (!q) return null;

	try {
		const gov = getGovernanceStore()
			.getState()
			.skills.find(
				s => s.enabled && (norm(s.id) === q || norm(s.title) === q || norm(s.id).endsWith(':' + q))
			);
		if (gov) {
			return { title: gov.title, body: gov.content.trim() };
		}
	} catch {
		/* ignore */
	}

	try {
		const disk = getSkillsRules()
			.listSkills()
			.find(
				(s: SkillDoc) =>
					norm(s.id) === q ||
					norm(s.title) === q ||
					norm(s.id).endsWith(':' + q) ||
					norm(s.id).includes(q)
			);
		if (disk) {
			return { title: disk.title, body: disk.content.trim() };
		}
	} catch {
		/* ignore */
	}

	return null;
}

/** Forced skill bodies for lean system (weak harness, razor, mode hints). */
export function buildForcedSkillSection(forceSkillIds: string[]): string {
	if (!forceSkillIds.length) return '';
	const blocks: string[] = [];
	const seen = new Set<string>();
	for (const id of forceSkillIds) {
		const key = norm(id);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const resolved = resolveSkillBody(id);
		if (!resolved?.body) continue;
		blocks.push(`### ${resolved.title}\n${clipText(resolved.body, 1200)}`);
	}
	if (!blocks.length) return '';
	return ['## Forced Skills', ...blocks].join('\n\n');
}
