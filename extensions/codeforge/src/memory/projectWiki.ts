/**
 * Project wiki + temporal facts — persisted under {workspace}/.CodeForge/memory/
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir, projectMemoryDir } from '../storage/paths';

export interface WikiDocument {
	id: string;
	title: string;
	content: string;
	keywords: string[];
	summary: string;
	category: string;
	createdAt: string;
	updatedAt: string;
}

export interface TemporalFact {
	id: string;
	key: string;
	value: string;
	validFrom: string;
	validTo?: string;
	supersededBy?: string;
	reason?: string;
}

interface WikiFile {
	documents: WikiDocument[];
	facts: TemporalFact[];
}

export class ProjectWikiStore {
	private docs = new Map<string, WikiDocument>();
	private facts = new Map<string, TemporalFact>();
	private root?: string;
	private ready = false;

	async initialize(workspaceFolder?: string): Promise<void> {
		this.root = await ensureDir(projectMemoryDir(workspaceFolder));
		await this.load();
		this.ready = true;
	}

	isReady(): boolean {
		return this.ready;
	}

	private filePath(): string {
		if (!this.root) throw new Error('ProjectWikiStore not initialized');
		return path.join(this.root, 'wiki.json');
	}

	private async load(): Promise<void> {
		this.docs.clear();
		this.facts.clear();
		try {
			const raw = await fs.readFile(this.filePath(), 'utf8');
			const data = JSON.parse(raw) as WikiFile;
			for (const d of data.documents ?? []) this.docs.set(d.id, d);
			for (const f of data.facts ?? []) this.facts.set(f.id, f);
		} catch {
			/* empty */
		}
	}

	async save(): Promise<void> {
		if (!this.root) {
			throw new Error(
				'Project wiki is not initialized (no workspace memory root). Open a folder and retry.'
			);
		}
		const data: WikiFile = {
			documents: Array.from(this.docs.values()),
			facts: Array.from(this.facts.values()),
		};
		await fs.writeFile(this.filePath(), JSON.stringify(data, null, 2), 'utf8');
	}

	private ensureReady(): void {
		if (!this.ready || !this.root) {
			throw new Error(
				'Project wiki is not initialized. Open a workspace folder before using wiki_write / wiki_fact.'
			);
		}
	}

	listDocuments(): WikiDocument[] {
		return Array.from(this.docs.values()).sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
	}

	getDocument(id: string): WikiDocument | undefined {
		return this.docs.get(id);
	}

	async upsertDocument(
		id: string,
		title: string,
		content: string,
		category = 'general'
	): Promise<WikiDocument> {
		this.ensureReady();
		const now = new Date().toISOString();
		const existing = this.docs.get(id);
		const doc: WikiDocument = existing
			? {
					...existing,
					title,
					content,
					category,
					keywords: extractKeywords(content),
					summary: summarize(content),
					updatedAt: now,
				}
			: {
					id,
					title,
					content,
					category,
					keywords: extractKeywords(content),
					summary: summarize(content),
					createdAt: now,
					updatedAt: now,
				};
		this.docs.set(id, doc);
		await this.save();
		const mdPath = path.join(this.root!, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
		await fs.writeFile(mdPath, `# ${title}\n\n${content}\n`, 'utf8');
		return doc;
	}

	search(query: string, limit = 5): WikiDocument[] {
		const q = query.toLowerCase();
		const scored = this.listDocuments().map(d => {
			let score = 0;
			if (d.title.toLowerCase().includes(q)) score += 5;
			if (d.content.toLowerCase().includes(q)) score += 2;
			for (const k of d.keywords) {
				if (q.includes(k) || k.includes(q)) score += 1;
			}
			return { d, score };
		});
		return scored
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(s => s.d);
	}

	async addFact(key: string, value: string, reason?: string): Promise<TemporalFact> {
		this.ensureReady();
		const now = new Date().toISOString();
		// Supersede any current fact with same key
		for (const f of this.facts.values()) {
			if (f.key === key && !f.validTo) {
				const newId = crypto.randomUUID();
				f.validTo = now;
				f.supersededBy = newId;
				f.reason = f.reason ?? reason;
				const next: TemporalFact = {
					id: newId,
					key,
					value,
					validFrom: now,
					reason,
				};
				this.facts.set(newId, next);
				await this.save();
				return next;
			}
		}
		const fact: TemporalFact = {
			id: crypto.randomUUID(),
			key,
			value,
			validFrom: now,
			reason,
		};
		this.facts.set(fact.id, fact);
		await this.save();
		return fact;
	}

	async supersedeFact(factId: string, newValue: string, reason?: string): Promise<TemporalFact | undefined> {
		const old = this.facts.get(factId);
		if (!old) return undefined;
		return this.addFact(old.key, newValue, reason ?? `supersede ${factId}`);
	}

	currentFacts(asOf = new Date()): TemporalFact[] {
		const t = asOf.toISOString();
		return Array.from(this.facts.values()).filter(
			f => f.validFrom <= t && (!f.validTo || f.validTo > t)
		);
	}

	formatForPrompt(maxChars = 3000): string {
		const docs = this.listDocuments().slice(0, 8);
		const facts = this.currentFacts().slice(0, 30);
		if (!docs.length && !facts.length) return '';
		const parts = [
			'## PROJECT WIKI',
			facts.length
				? `### Current facts\n${facts.map(f => `- ${f.key}: ${f.value}`).join('\n')}`
				: '',
			docs.length
				? `### Documents\n${docs
						.map(d => `#### ${d.title}\n${d.summary || d.content.slice(0, 400)}`)
						.join('\n\n')}`
				: '',
		].filter(Boolean);
		let out = parts.join('\n\n');
		if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…[project wiki truncated]';
		return out;
	}
}

function extractKeywords(content: string): string[] {
	const words = content
		.toLowerCase()
		.replace(/[^a-z0-9_\-./]+/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 3);
	return Array.from(new Set(words)).slice(0, 24);
}

function summarize(content: string): string {
	const line = content.split(/\r?\n/).find(l => l.trim()) ?? '';
	return line.slice(0, 160);
}

let shared: ProjectWikiStore | undefined;

export function getProjectWikiStore(): ProjectWikiStore {
	if (!shared) shared = new ProjectWikiStore();
	return shared;
}

export async function initProjectWiki(workspaceFolder?: string): Promise<ProjectWikiStore> {
	const store = getProjectWikiStore();
	await store.initialize(workspaceFolder);
	return store;
}

/** Ensure wiki is bound to the current workspace (no-op if already ready for that root). */
export async function ensureProjectWiki(workspaceFolder?: string): Promise<ProjectWikiStore> {
	const store = getProjectWikiStore();
	if (!store.isReady() || workspaceFolder) {
		await store.initialize(workspaceFolder);
	}
	return store;
}
