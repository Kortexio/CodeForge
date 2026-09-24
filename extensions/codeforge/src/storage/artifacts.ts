/**
 * Artifacts store — large tool/LLM outputs on disk with prompt handles.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { artifactsDir, ensureDir } from './paths';
import { clipToolOutput } from '../agent/clip';

export interface ArtifactMeta {
	id: string;
	name: string;
	type: string;
	path: string;
	bytes: number;
	createdAt: string;
	sessionId?: string;
}

const INDEX = 'index.json';

export class ArtifactStore {
	private index: ArtifactMeta[] = [];
	private loaded = false;

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		await ensureDir(artifactsDir());
		try {
			const raw = await fs.readFile(path.join(artifactsDir(), INDEX), 'utf8');
			this.index = JSON.parse(raw) as ArtifactMeta[];
		} catch {
			this.index = [];
		}
		this.loaded = true;
	}

	private async persistIndex(): Promise<void> {
		await ensureDir(artifactsDir());
		await fs.writeFile(
			path.join(artifactsDir(), INDEX),
			JSON.stringify(this.index.slice(-500), null, 2),
			'utf8'
		);
	}

	async create(
		type: string,
		name: string,
		content: string | Buffer,
		sessionId?: string
	): Promise<ArtifactMeta> {
		await this.ensureLoaded();
		const id = crypto.randomUUID();
		const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
		const fileName = `${id.slice(0, 8)}-${safe}`;
		const filePath = path.join(artifactsDir(), fileName);
		const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		await fs.writeFile(filePath, buf);
		const meta: ArtifactMeta = {
			id,
			name,
			type,
			path: filePath,
			bytes: buf.byteLength,
			createdAt: new Date().toISOString(),
			sessionId,
		};
		this.index.push(meta);
		await this.persistIndex();
		return meta;
	}

	/**
	 * If content exceeds maxChars, persist full body and return excerpt + handle for the prompt.
	 */
	async maybeSpill(
		content: string,
		opts: { maxChars: number; name: string; type?: string; sessionId?: string }
	): Promise<{ text: string; artifact?: ArtifactMeta }> {
		if (content.length <= opts.maxChars) {
			return { text: content };
		}
		const artifact = await this.create(
			opts.type ?? 'tool-output',
			opts.name,
			content,
			opts.sessionId
		);
		const pointer = `\n…[full output (${content.length} chars) saved to ${artifact.path}]`;
		const budget = Math.max(500, opts.maxChars - pointer.length);
		const excerpt = clipToolOutput(opts.name.split('-')[0], content, budget) + pointer;
		return { text: excerpt, artifact };
	}

	async read(id: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const meta = this.index.find(a => a.id === id);
		if (!meta) return undefined;
		return fs.readFile(meta.path, 'utf8');
	}

	list(sessionId?: string): ArtifactMeta[] {
		return this.index.filter(a => !sessionId || a.sessionId === sessionId);
	}
}

let shared: ArtifactStore | undefined;

export function getArtifactStore(): ArtifactStore {
	if (!shared) shared = new ArtifactStore();
	return shared;
}
