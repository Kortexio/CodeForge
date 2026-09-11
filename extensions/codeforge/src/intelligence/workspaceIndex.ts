/**
 * Persistent workspace index + hybrid (lexical + semantic) retrieve.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { codeIndexDir, ensureDir } from '../storage/paths';
import { embedTexts } from './embeddings';

export interface RetrieveHit {
	path: string;
	startLine: number;
	text: string;
	score?: number;
	source?: 'lexical' | 'semantic' | 'hybrid';
}

export interface IndexEntry {
	path: string;
	hash: string;
	mtimeMs: number;
	size: number;
	preview?: string;
}

export interface EmbeddingChunk {
	path: string;
	startLine: number;
	text: string;
	embedding: number[];
}

interface IndexFile {
	workspace: string;
	updatedAt: string;
	entries: IndexEntry[];
	embeddings?: EmbeddingChunk[];
}

const EXCLUDE = '**/{node_modules,.git,bin,obj,dist,out,.vs,coverage,.next,target}/**';
const SCAN_FILE_CAP = 800;
const SCAN_BYTES_CAP = 400_000;

let memoryPaths: string[] = [];
let embeddingChunks: EmbeddingChunk[] = [];
let indexRoot: string | undefined;

export async function ensureWorkspaceIndex(): Promise<{ indexed: number }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		memoryPaths = [];
		return { indexed: 0 };
	}
	indexRoot = await ensureDir(codeIndexDir(folder));
	const files = await vscode.workspace.findFiles('**/*', EXCLUDE, SCAN_FILE_CAP);
	const entries: IndexEntry[] = [];
	for (const uri of files) {
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > SCAN_BYTES_CAP) continue;
			const rel = vscode.workspace.asRelativePath(uri);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);
			const text = Buffer.from(bytes).toString('utf8');
			entries.push({
				path: rel,
				hash,
				mtimeMs: stat.mtime,
				size: stat.size,
				preview: text.slice(0, 400),
			});
		} catch {
			/* skip */
		}
	}
	memoryPaths = entries.map(e => e.path);
	let existingEmbeddings: EmbeddingChunk[] = [];
	try {
		const prev = JSON.parse(
			await fs.readFile(path.join(indexRoot, 'index.json'), 'utf8')
		) as IndexFile;
		existingEmbeddings = prev.embeddings ?? [];
	} catch {
		/* ok */
	}
	embeddingChunks = existingEmbeddings;
	const payload: IndexFile = {
		workspace: folder,
		updatedAt: new Date().toISOString(),
		entries,
		embeddings: embeddingChunks,
	};
	await fs.writeFile(path.join(indexRoot, 'index.json'), JSON.stringify(payload), 'utf8');
	return { indexed: entries.length };
}

export function contextBadge(
	keyPaths: string[],
	retrieved: string[],
	openRel?: string
): { indexed: number; inContext: number } {
	const set = new Set(
		[...keyPaths, ...retrieved, openRel]
			.filter(Boolean)
			.map(p => p!.replace(/\\/g, '/').toLowerCase())
	);
	return { indexed: memoryPaths.length, inContext: set.size };
}

export function getIndexedCount(): number {
	return memoryPaths.length;
}

export async function retrieveSnippets(query: string, k = 6): Promise<RetrieveHit[]> {
	const lexical = await lexicalRetrieve(query, k);
	const semantic = await semanticRetrieve(query, Math.max(2, Math.floor(k / 2)));
	const merged = new Map<string, RetrieveHit>();
	for (const h of [...semantic, ...lexical]) {
		const key = `${h.path}:${h.startLine}`;
		const prev = merged.get(key);
		if (!prev || (h.score ?? 0) > (prev.score ?? 0)) {
			merged.set(key, h);
		}
	}
	return Array.from(merged.values())
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
		.slice(0, k);
}

async function lexicalRetrieve(query: string, k: number): Promise<RetrieveHit[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return [];
	const pattern = query.trim().slice(0, 80) || '.';
	try {
		const hits = await vscode.workspace.findFiles('**/*', EXCLUDE, 200);
		const out: RetrieveHit[] = [];
		let re: RegExp;
		try {
			re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
		} catch {
			re = /./i;
		}
		for (const uri of hits) {
			if (out.length >= k * 3) break;
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				if (bytes.byteLength > SCAN_BYTES_CAP) continue;
				const text = Buffer.from(bytes).toString('utf8');
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (re.test(lines[i])) {
						const start = Math.max(0, i - 1);
						const snippet = lines.slice(start, i + 3).join('\n');
						out.push({
							path: vscode.workspace.asRelativePath(uri),
							startLine: i + 1,
							text: snippet,
							score: 1,
							source: 'lexical',
						});
						break;
					}
				}
			} catch {
				/* skip */
			}
		}
		return out.slice(0, k);
	} catch {
		return [];
	}
}

async function semanticRetrieve(query: string, k: number): Promise<RetrieveHit[]> {
	if (!embeddingChunks.length) {
		await loadEmbeddingsFromDisk();
	}
	if (!embeddingChunks.length) return [];
	try {
		const [qVec] = await embedTexts([query]);
		if (!qVec?.length) return [];
		const scored = embeddingChunks.map(c => ({
			c,
			score: cosine(qVec, c.embedding),
		}));
		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, k)
			.map(s => ({
				path: s.c.path,
				startLine: s.c.startLine,
				text: s.c.text,
				score: s.score,
				source: 'semantic' as const,
			}));
	} catch {
		return [];
	}
}

async function loadEmbeddingsFromDisk(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) return;
	try {
		const raw = await fs.readFile(path.join(codeIndexDir(folder), 'index.json'), 'utf8');
		const data = JSON.parse(raw) as IndexFile;
		embeddingChunks = data.embeddings ?? [];
		memoryPaths = (data.entries ?? []).map(e => e.path);
	} catch {
		/* empty */
	}
}

export async function indexEmbeddings(maxFiles = 80): Promise<number> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return 0;
	await ensureWorkspaceIndex();
	const files = await vscode.workspace.findFiles(
		'**/*.{ts,tsx,js,jsx,cs,py,go,rs,md}',
		EXCLUDE,
		maxFiles
	);
	const chunks: { path: string; startLine: number; text: string }[] = [];
	for (const uri of files) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > 80_000) continue;
			const text = Buffer.from(bytes).toString('utf8');
			const rel = vscode.workspace.asRelativePath(uri);
			const parts = text.match(/[\s\S]{1,800}/g) ?? [text.slice(0, 800)];
			let line = 1;
			for (const part of parts.slice(0, 4)) {
				chunks.push({ path: rel, startLine: line, text: part });
				line += part.split(/\r?\n/).length;
			}
		} catch {
			/* skip */
		}
	}
	if (!chunks.length) return 0;
	const vectors = await embedTexts(chunks.map(c => c.text));
	embeddingChunks = chunks
		.map((c, i) => ({
			...c,
			embedding: vectors[i] ?? [],
		}))
		.filter(c => c.embedding.length > 0);

	indexRoot = await ensureDir(codeIndexDir(folder.uri.fsPath));
	let existing: IndexFile = {
		workspace: folder.uri.fsPath,
		updatedAt: new Date().toISOString(),
		entries: [],
	};
	try {
		existing = JSON.parse(await fs.readFile(path.join(indexRoot, 'index.json'), 'utf8')) as IndexFile;
	} catch {
		/* ok */
	}
	existing.embeddings = embeddingChunks;
	existing.updatedAt = new Date().toISOString();
	await fs.writeFile(path.join(indexRoot, 'index.json'), JSON.stringify(existing), 'utf8');
	return embeddingChunks.length;
}

function cosine(a: number[], b: number[]): number {
	if (!a.length || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d ? dot / d : 0;
}

export function formatRetrievedBlock(hits: RetrieveHit[]): string {
	if (!hits.length) return '';
	return [
		'### RETRIEVED',
		...hits.map(
			h =>
				`#### ${h.path}:${h.startLine} (${h.source ?? 'lexical'}${
					h.score !== undefined ? ` score=${h.score.toFixed(3)}` : ''
				})\n\`\`\`\n${h.text.slice(0, 600)}\n\`\`\``
		),
	].join('\n\n');
}
