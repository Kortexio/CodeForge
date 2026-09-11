/**
 * Session wiki — Markdown pages + working memory that survive compaction.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir, sessionWikiDir } from '../storage/paths';
import { StableFacts, formatStableFactsBlock, normalizeFacts } from '../agent/stableFacts';

export interface WorkingMemory {
	objective: string;
	plan: string[];
	recentTools: string[];
	blockers: string[];
	items: string[];
}

export interface WikiPage {
	id: string;
	title: string;
	content: string;
	updatedAt: string;
}

export interface SessionWiki {
	sessionId: string;
	pages: WikiPage[];
	workingMemory: WorkingMemory;
	stableFacts: StableFacts;
	index: string;
	updatedAt: string;
}

function emptyWorking(objective = ''): WorkingMemory {
	return {
		objective,
		plan: [],
		recentTools: [],
		blockers: [],
		items: [],
	};
}

export function emptySessionWiki(sessionId: string, objective = ''): SessionWiki {
	return {
		sessionId,
		pages: [],
		workingMemory: emptyWorking(objective),
		stableFacts: normalizeFacts(),
		index: `# Session\n\nObjective: ${objective || '(none)'}`,
		updatedAt: new Date().toISOString(),
	};
}

export class SessionWikiStore {
	private cache = new Map<string, SessionWiki>();

	async load(sessionId: string): Promise<SessionWiki> {
		const cached = this.cache.get(sessionId);
		if (cached) return cached;
		const dir = sessionWikiDir(sessionId);
		const metaPath = path.join(dir, 'wiki.json');
		try {
			const raw = await fs.readFile(metaPath, 'utf8');
			const parsed = JSON.parse(raw) as SessionWiki;
			parsed.stableFacts = normalizeFacts(parsed.stableFacts);
			parsed.workingMemory = { ...emptyWorking(), ...parsed.workingMemory };
			parsed.pages = parsed.pages ?? [];
			this.cache.set(sessionId, parsed);
			return parsed;
		} catch {
			const fresh = emptySessionWiki(sessionId);
			this.cache.set(sessionId, fresh);
			return fresh;
		}
	}

	async save(wiki: SessionWiki): Promise<void> {
		wiki.updatedAt = new Date().toISOString();
		const dir = await ensureDir(sessionWikiDir(wiki.sessionId));
		await fs.writeFile(path.join(dir, 'wiki.json'), JSON.stringify(wiki, null, 2), 'utf8');
		for (const page of wiki.pages) {
			const safe = page.id.replace(/[^a-zA-Z0-9_-]/g, '_');
			await fs.writeFile(path.join(dir, `${safe}.md`), page.content, 'utf8');
		}
		this.cache.set(wiki.sessionId, wiki);
	}

	async ensure(sessionId: string, objective?: string): Promise<SessionWiki> {
		const wiki = await this.load(sessionId);
		if (objective && !wiki.workingMemory.objective) {
			wiki.workingMemory.objective = objective;
			wiki.index = `# Session\n\nObjective: ${objective}`;
			await this.save(wiki);
		}
		return wiki;
	}

	async upsertPage(sessionId: string, id: string, title: string, content: string): Promise<WikiPage> {
		const wiki = await this.load(sessionId);
		const now = new Date().toISOString();
		const existing = wiki.pages.find(p => p.id === id);
		if (existing) {
			existing.title = title;
			existing.content = content;
			existing.updatedAt = now;
		} else {
			wiki.pages.push({ id, title, content, updatedAt: now });
		}
		await this.save(wiki);
		return wiki.pages.find(p => p.id === id)!;
	}

	async setWorkingMemory(sessionId: string, patch: Partial<WorkingMemory>): Promise<WorkingMemory> {
		const wiki = await this.load(sessionId);
		wiki.workingMemory = { ...wiki.workingMemory, ...patch };
		if (patch.recentTools) {
			wiki.workingMemory.recentTools = patch.recentTools.slice(-20);
		}
		await this.save(wiki);
		return wiki.workingMemory;
	}

	async pushTool(sessionId: string, toolName: string): Promise<void> {
		const wiki = await this.load(sessionId);
		wiki.workingMemory.recentTools = [...wiki.workingMemory.recentTools, toolName].slice(-20);
		await this.save(wiki);
	}

	async setStableFacts(sessionId: string, facts: StableFacts): Promise<void> {
		const wiki = await this.load(sessionId);
		wiki.stableFacts = normalizeFacts(facts);
		await this.upsertPage(
			sessionId,
			'stable-facts',
			'Stable Facts',
			formatStableFactsBlock(wiki.stableFacts) || '_empty_'
		);
		await this.save(wiki);
	}

	formatForPrompt(wiki: SessionWiki, maxChars = 4000): string {
		const wm = wiki.workingMemory;
		const pages = wiki.pages
			.filter(p => p.id !== 'stable-facts')
			.slice(0, 6)
			.map(p => `#### ${p.title}\n${p.content.slice(0, 800)}`)
			.join('\n\n');
		const parts = [
			'## SESSION WIKI',
			wm.objective ? `**Objective:** ${wm.objective}` : '',
			wm.plan.length ? `**Plan:**\n${wm.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
			wm.blockers.length ? `**Blockers:** ${wm.blockers.join('; ')}` : '',
			wm.recentTools.length ? `**Recent tools:** ${wm.recentTools.slice(-8).join(', ')}` : '',
			formatStableFactsBlock(wiki.stableFacts),
			pages ? `### Pages\n${pages}` : '',
		].filter(Boolean);
		let out = parts.join('\n\n');
		if (out.length > maxChars) {
			out = out.slice(0, maxChars) + '\n…[wiki truncated]';
		}
		return out;
	}
}

let shared: SessionWikiStore | undefined;

export function getSessionWikiStore(): SessionWikiStore {
	if (!shared) shared = new SessionWikiStore();
	return shared;
}
