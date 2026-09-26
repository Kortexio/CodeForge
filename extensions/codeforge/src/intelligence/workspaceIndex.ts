/**
 * Persistent workspace index + hybrid (lexical + semantic) retrieve.
 * Incremental by file hash; vectors in vectors.f32; lexical postings in memory.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { codeIndexDir, ensureDir } from '../storage/paths';
import { embedTexts } from './embeddings';
import { chunkFile, type CodeChunk, type SymbolSpan } from './chunker';
import { queryTerms, scoreFileText, minTermsRequired } from './lexicalScore';
import { documentSymbolRanges } from './lspBridge';
import { parseKeepIndices, buildRerankPrompt } from './rerank';

export interface RetrieveHit {
	path: string;
	startLine: number;
	endLine?: number;
	text: string;
	score?: number;
	source?: 'lexical' | 'semantic' | 'hybrid';
	symbol?: string;
}

export interface IndexEntry {
	path: string;
	hash: string;
	mtimeMs: number;
	size: number;
	preview?: string;
}

interface ChunkMeta {
	path: string;
	startLine: number;
	endLine: number;
	symbol?: string;
	header: string;
	text: string;
	/** Offset into vectors.f32 (in floats); -1 if no embedding. */
	vecOffset: number;
	dim: number;
}

interface IndexFile {
	workspace: string;
	updatedAt: string;
	version: 2;
	entries: IndexEntry[];
	chunks: ChunkMeta[];
	vectorDim: number;
	vectorCount: number;
}

const EXCLUDE =
	'**/{node_modules,.git,bin,obj,dist,out,.vs,coverage,.next,target,.CodeForge}/**';
const CODE_GLOB = '**/*.{ts,tsx,js,jsx,cs,py,go,rs,md}';
const SCAN_FILE_CAP = 3000;
const SCAN_BYTES_CAP = 200_000;
const EMBED_BATCH = 64;
const BINARY_EXT =
	/\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|7z|tar|exe|dll|pdb|so|dylib|bin|woff2?|ttf|otf|eot|mp[34]|wav|db|sqlite|lock|nupkg|snk|pfx)$/i;

let memoryPaths: string[] = [];
let chunkMetas: ChunkMeta[] = [];
let vectorBuffer: Float32Array = new Float32Array(0);
let vectorDim = 0;
let indexRoot: string | undefined;
/** term → chunk indices */
let lexicalPostings = new Map<string, number[]>();
let indexReady = false;

export function pathsNeedingReindex(
	prev: Array<{ path: string; hash: string }>,
	next: Array<{ path: string; hash: string }>
): string[] {
	const prevByPath = new Map(prev.map(e => [e.path, e.hash]));
	return next.filter(e => prevByPath.get(e.path) !== e.hash).map(e => e.path);
}

export async function ensureWorkspaceIndex(): Promise<{ indexed: number }> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		memoryPaths = [];
		chunkMetas = [];
		return { indexed: 0 };
	}
	indexRoot = await ensureDir(codeIndexDir(folder));
	const files = await vscode.workspace.findFiles(CODE_GLOB, EXCLUDE, SCAN_FILE_CAP);
	const entries: IndexEntry[] = [];
	for (const uri of files) {
		try {
			if (BINARY_EXT.test(uri.fsPath)) continue;
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > SCAN_BYTES_CAP) continue;
			const rel = vscode.workspace.asRelativePath(uri);
			if (rel.replace(/\\/g, '/').includes('/.CodeForge/')) continue;
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

	let prev: IndexFile | null = null;
	try {
		prev = JSON.parse(await fs.readFile(path.join(indexRoot, 'index.json'), 'utf8')) as IndexFile;
	} catch {
		/* ok */
	}

	// Load existing vectors if present
	if (prev?.version === 2 && prev.vectorCount > 0 && prev.vectorDim > 0) {
		try {
			const buf = await fs.readFile(path.join(indexRoot, 'vectors.f32'));
			vectorBuffer = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
			vectorDim = prev.vectorDim;
			chunkMetas = prev.chunks ?? [];
		} catch {
			vectorBuffer = new Float32Array(0);
			vectorDim = 0;
			chunkMetas = [];
		}
	} else {
		// Migrate away from v1 embedding JSON if needed
		vectorBuffer = new Float32Array(0);
		vectorDim = 0;
		chunkMetas = [];
	}

	const prevByPath = new Map((prev?.entries ?? []).map(e => [e.path, e]));
	const keepChunks = chunkMetas.filter(c => {
		const pe = prevByPath.get(c.path);
		const ne = entries.find(e => e.path === c.path);
		return pe && ne && pe.hash === ne.hash;
	});

	const changedPaths = new Set(
		pathsNeedingReindex(prev?.entries ?? [], entries)
	);
	const changed = entries.filter(e => changedPaths.has(e.path));

	const newChunks: ChunkMeta[] = [...keepChunks];
	for (const e of changed) {
		try {
			const uri = vscode.Uri.file(
				path.isAbsolute(e.path)
					? e.path
					: path.join(folder, e.path)
			);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(bytes).toString('utf8');
			let symbols: SymbolSpan[] | undefined;
			try {
				const ranges = await documentSymbolRanges(e.path);
				symbols = ranges.map(r => ({
					name: r.name,
					kind: r.kind,
					startLine: r.startLine,
					endLine: r.endLine,
				}));
			} catch {
				symbols = undefined;
			}
			const parts = chunkFile(e.path, text, symbols);
			for (const part of parts) {
				newChunks.push(chunkToMeta(part, -1, 0));
			}
		} catch {
			/* skip */
		}
	}

	chunkMetas = newChunks;
	rebuildLexicalPostings();

	const payload: IndexFile = {
		workspace: folder,
		updatedAt: new Date().toISOString(),
		version: 2,
		entries,
		chunks: chunkMetas,
		vectorDim,
		vectorCount: vectorDim > 0 ? Math.floor(vectorBuffer.length / vectorDim) : 0,
	};
	await fs.writeFile(path.join(indexRoot, 'index.json'), JSON.stringify(payload), 'utf8');
	indexReady = true;
	return { indexed: entries.length };
}

function chunkToMeta(c: CodeChunk, vecOffset: number, dim: number): ChunkMeta {
	return {
		path: c.path,
		startLine: c.startLine,
		endLine: c.endLine,
		symbol: c.symbol,
		header: c.header,
		text: c.text,
		vecOffset,
		dim,
	};
}

function rebuildLexicalPostings(): void {
	lexicalPostings = new Map();
	chunkMetas.forEach((c, i) => {
		const terms = queryTerms(c.text, 40);
		for (const t of terms) {
			const list = lexicalPostings.get(t) ?? [];
			list.push(i);
			lexicalPostings.set(t, list);
		}
	});
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

export function hasSemanticEmbeddings(): boolean {
	return vectorDim > 0 && vectorBuffer.length >= vectorDim;
}

export function getChunkCount(): number {
	return chunkMetas.length;
}

export async function retrieveSnippets(
	query: string,
	k = 6,
	opts?: {
		rerank?: boolean;
		candidateK?: number;
		rerankFn?: (prompt: string) => Promise<string>;
	}
): Promise<RetrieveHit[]> {
	if (!indexReady && !chunkMetas.length) {
		await ensureWorkspaceIndex().catch(() => undefined);
		await loadIndexFromDisk().catch(() => undefined);
	}

	const candidateK = opts?.candidateK ?? Math.max(k * 4, 30);
	const lexical = lexicalRetrieveFromPostings(query, candidateK);
	const semantic = await semanticRetrieve(query, Math.max(2, Math.floor(candidateK / 2)));
	const merged = new Map<string, RetrieveHit>();
	for (const h of [...semantic, ...lexical]) {
		const key = `${h.path}:${h.startLine}`;
		const prev = merged.get(key);
		if (!prev || (h.score ?? 0) > (prev.score ?? 0)) {
			merged.set(key, {
				...h,
				source:
					prev && prev.source !== h.source
						? 'hybrid'
						: h.source,
			});
		}
	}
	let ranked = Array.from(merged.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	let configRerank = true;
	try {
		configRerank =
			vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('retrieveRerank') !== false;
	} catch {
		configRerank = true;
	}
	const wantRerank =
		opts?.rerank !== false &&
		ranked.length > k &&
		(opts?.rerank === true || configRerank);

	if (wantRerank && opts?.rerankFn) {
		try {
			const candidates = ranked.slice(0, candidateK);
			const prompt = buildRerankPrompt(
				query,
				candidates.map(c => ({
					path: c.path,
					startLine: c.startLine,
					endLine: c.endLine,
					symbol: c.symbol,
					text: c.text,
				})),
				k
			);
			const raw = await Promise.race([
				opts.rerankFn(prompt),
				new Promise<string>((_, rej) =>
					setTimeout(() => rej(new Error('rerank timeout')), 4000)
				),
			]);
			const keep = parseKeepIndices(raw, candidates.length);
			if (keep.length) {
				ranked = keep.map(i => candidates[i]).filter(Boolean);
			}
		} catch {
			/* keep score order */
		}
	}

	return ranked.slice(0, k);
}

function lexicalRetrieveFromPostings(query: string, k: number): RetrieveHit[] {
	const terms = queryTerms(query);
	if (!terms.length || !chunkMetas.length) return [];

	const candidateIdx = new Set<number>();
	for (const t of terms) {
		for (const i of lexicalPostings.get(t) ?? []) {
			candidateIdx.add(i);
		}
	}
	// Relax: if nothing, score all chunks lightly via path terms only
	const files = (
		candidateIdx.size
			? [...candidateIdx]
			: chunkMetas.map((_, i) => i)
	).map(i => ({
		path: chunkMetas[i].path,
		text: chunkMetas[i].text,
		meta: chunkMetas[i],
	}));

	const need = minTermsRequired(terms.length);
	const hits: RetrieveHit[] = [];
	for (const f of files) {
		const scored = scoreFileText(
			{ path: f.path, text: f.text },
			terms,
			{ phrase: query, minTerms: need, maxHits: 1 }
		);
		for (const h of scored) {
			hits.push({
				path: f.meta.path,
				startLine: f.meta.startLine,
				endLine: f.meta.endLine,
				text: f.meta.text.slice(0, 800),
				score: h.score,
				source: 'lexical',
				symbol: f.meta.symbol,
			});
		}
	}
	if (!hits.length && need > 1) {
		for (const f of files.slice(0, 200)) {
			const scored = scoreFileText(
				{ path: f.path, text: f.text },
				terms,
				{ phrase: query, minTerms: 1, maxHits: 1 }
			);
			for (const h of scored) {
				hits.push({
					path: f.meta.path,
					startLine: f.meta.startLine,
					endLine: f.meta.endLine,
					text: f.meta.text.slice(0, 800),
					score: h.score,
					source: 'lexical',
					symbol: f.meta.symbol,
				});
			}
		}
	}
	return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, k);
}

async function semanticRetrieve(query: string, k: number): Promise<RetrieveHit[]> {
	if (!hasSemanticEmbeddings() || !chunkMetas.length) return [];
	try {
		const [qVec] = await embedTexts([query]);
		if (!qVec?.length || qVec.length !== vectorDim) return [];
		const scored: Array<{ i: number; score: number }> = [];
		for (let i = 0; i < chunkMetas.length; i++) {
			const c = chunkMetas[i];
			if (c.vecOffset < 0 || c.dim !== vectorDim) continue;
			const score = cosineSlice(qVec, vectorBuffer, c.vecOffset, vectorDim);
			scored.push({ i, score });
		}
		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, k)
			.map(s => {
				const c = chunkMetas[s.i];
				return {
					path: c.path,
					startLine: c.startLine,
					endLine: c.endLine,
					text: c.text.slice(0, 800),
					score: s.score,
					source: 'semantic' as const,
					symbol: c.symbol,
				};
			});
	} catch {
		return [];
	}
}

function cosineSlice(q: number[], buf: Float32Array, offset: number, dim: number): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < dim; i++) {
		const a = q[i];
		const b = buf[offset + i];
		dot += a * b;
		na += a * a;
		nb += b * b;
	}
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d ? dot / d : 0;
}

async function loadIndexFromDisk(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) return;
	try {
		const raw = await fs.readFile(path.join(codeIndexDir(folder), 'index.json'), 'utf8');
		const data = JSON.parse(raw) as IndexFile;
		memoryPaths = (data.entries ?? []).map(e => e.path);
		chunkMetas = data.chunks ?? [];
		vectorDim = data.vectorDim ?? 0;
		if (data.version === 2 && data.vectorCount > 0 && vectorDim > 0) {
			const buf = await fs.readFile(path.join(codeIndexDir(folder), 'vectors.f32'));
			vectorBuffer = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
		}
		rebuildLexicalPostings();
		indexReady = true;
	} catch {
		/* empty */
	}
}

/**
 * Build / refresh semantic embeddings for changed chunks (incremental by hash via ensureWorkspaceIndex).
 * Pass forceAll to re-embed every chunk.
 */
export async function indexEmbeddings(maxFiles = 3000, forceAll = false): Promise<number> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return 0;
	await ensureWorkspaceIndex();

	const needEmbedIdx = forceAll
		? chunkMetas.map((_, i) => i)
		: chunkMetas.map((c, i) => (c.vecOffset < 0 ? i : -1)).filter(i => i >= 0);

	if (!needEmbedIdx.length && hasSemanticEmbeddings()) {
		return chunkMetas.filter(c => c.vecOffset >= 0).length;
	}

	const byPath = new Set<string>();
	const toEmbed: number[] = [];
	const source = needEmbedIdx.length ? needEmbedIdx : chunkMetas.map((_, i) => i);
	for (const i of source) {
		const p = chunkMetas[i].path;
		if (!byPath.has(p) && byPath.size >= maxFiles) continue;
		byPath.add(p);
		toEmbed.push(i);
	}

	const embedSet = new Set(toEmbed);
	const texts = toEmbed.map(i => chunkMetas[i].text.slice(0, 2000));
	const allVectors: number[][] = [];
	for (let b = 0; b < texts.length; b += EMBED_BATCH) {
		const batch = texts.slice(b, b + EMBED_BATCH);
		try {
			const vectors = await embedTexts(batch);
			allVectors.push(...vectors);
		} catch {
			return 0;
		}
	}

	const dim = allVectors.find(v => v.length)?.length ?? 0;
	if (!dim) return 0;

	const newBuf: number[] = [];
	let embedIdx = 0;
	const updated: ChunkMeta[] = chunkMetas.map((c, i) => {
		if (embedSet.has(i)) {
			const vec = allVectors[embedIdx++] ?? [];
			if (!vec.length) {
				return { ...c, vecOffset: -1, dim: 0 };
			}
			const offset = newBuf.length;
			newBuf.push(...vec);
			return { ...c, vecOffset: offset, dim };
		}
		if (c.vecOffset >= 0 && c.dim > 0 && c.dim === vectorDim && vectorBuffer.length) {
			const offset = newBuf.length;
			for (let j = 0; j < c.dim; j++) {
				newBuf.push(vectorBuffer[c.vecOffset + j]);
			}
			return { ...c, vecOffset: offset, dim: c.dim };
		}
		return { ...c, vecOffset: -1, dim: 0 };
	});

	vectorDim = dim;
	vectorBuffer = new Float32Array(newBuf);
	chunkMetas = updated;
	rebuildLexicalPostings();

	indexRoot = await ensureDir(codeIndexDir(folder.uri.fsPath));
	let entries: IndexEntry[] = [];
	try {
		const prev = JSON.parse(
			await fs.readFile(path.join(indexRoot, 'index.json'), 'utf8')
		) as IndexFile;
		entries = prev.entries ?? [];
	} catch {
		/* ok */
	}

	const payload: IndexFile = {
		workspace: folder.uri.fsPath,
		updatedAt: new Date().toISOString(),
		version: 2,
		entries,
		chunks: chunkMetas,
		vectorDim: dim,
		vectorCount: Math.floor(vectorBuffer.length / dim),
	};
	await fs.writeFile(path.join(indexRoot, 'index.json'), JSON.stringify(payload), 'utf8');
	const ab = Buffer.from(vectorBuffer.buffer, vectorBuffer.byteOffset, vectorBuffer.byteLength);
	await fs.writeFile(path.join(indexRoot, 'vectors.f32'), ab);

	return chunkMetas.filter(c => c.vecOffset >= 0).length;
}

export function formatRetrievedBlock(hits: RetrieveHit[]): string {
	if (!hits.length) return '';
	return [
		'### RETRIEVED',
		...hits.map(h => {
			const end = h.endLine ?? h.startLine;
			const limit = Math.max(1, end - h.startLine + 1);
			const sym = h.symbol ? ` ${h.symbol}` : '';
			return `#### ${h.path}:${h.startLine}-${end}${sym} (${h.source ?? 'lexical'}${
				h.score !== undefined ? ` score=${h.score.toFixed(3)}` : ''
			})\n\`\`\`\n${h.text.slice(0, 600)}\n\`\`\`\n→ read { path: "${h.path}", startLine: ${h.startLine}, limit: ${limit} }`;
		}),
	].join('\n\n');
}

/** Test helpers */
export function resetWorkspaceIndexForTests(): void {
	memoryPaths = [];
	chunkMetas = [];
	vectorBuffer = new Float32Array(0);
	vectorDim = 0;
	lexicalPostings = new Map();
	indexReady = false;
	indexRoot = undefined;
}

export function seedChunksForTests(chunks: CodeChunk[]): void {
	chunkMetas = chunks.map(c => chunkToMeta(c, -1, 0));
	memoryPaths = [...new Set(chunks.map(c => c.path))];
	rebuildLexicalPostings();
	indexReady = true;
}
