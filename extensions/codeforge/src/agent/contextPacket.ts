/**
 * Context packet — assembled each LLM round via Context Engine + Memory.
 */

import * as vscode from 'vscode';
import * as lsp from '../intelligence/lspBridge';
import * as git from '../intelligence/gitTools';
import {
	formatRetrievedBlock,
	retrieveSnippets,
	contextBadge,
	ensureWorkspaceIndex,
	getIndexedCount,
	hasSemanticEmbeddings,
	RetrieveHit,
} from '../intelligence/workspaceIndex';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StableFacts, normalizeFacts } from './stableFacts';
import {
	assembleContext,
	DEFAULT_BUDGET,
	factsSource,
	type ContextBudget,
	type ContextSource,
} from '../context/engine';
import { getSessionWikiStore } from '../memory/sessionWiki';
import { getProjectWikiStore } from '../memory/projectWiki';
import { emptyStatusPrompt, formatStatusForPrompt, loadProjectStatus, parseRepoSnapshot } from './projectStatus';
import { clipData } from './clip';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ContextPacketResult {
	markdown: string;
	retrieved: RetrieveHit[];
	badge: { indexed: number; inContext: number };
	included?: string[];
}

export async function buildContextPacket(opts: {
	task: string;
	facts?: StableFacts;
	workspaceRoot?: string;
	includeRetrieve?: boolean;
	retrieveK?: number;
	sessionId?: string;
	budget?: ContextBudget;
	/** Paths touched this run — boost retrieve/ide priority. */
	boostPaths?: string[];
	/** Recent chat history snippet for the history budget slot. */
	historyText?: string;
}): Promise<ContextPacketResult> {
	await ensureWorkspaceIndex().catch(() => undefined);

	const facts = normalizeFacts(opts.facts);
	const ide = await gatherIdeState();
	const capabilities = await gatherToolCapabilities(opts.workspaceRoot, ide.gitAvailable);
	const prefetch = await gatherWorkspacePrefetch(opts.workspaceRoot);
	const lspOutline = await gatherActiveLspOutline();
	let retrieved: RetrieveHit[] = [];
	let retrieveNote = '';
	if (opts.includeRetrieve !== false) {
		try {
			retrieved = await retrieveSnippets(opts.task, opts.retrieveK ?? 6);
		} catch (err) {
			retrieveNote = `(retrieve failed: ${err instanceof Error ? err.message : String(err)})`;
			retrieved = [];
		}
	}

	const sources: ContextSource[] = [];
	const boost = new Set(
		[...(opts.boostPaths || []), ...ide.editorPaths].map(p =>
			p.replace(/\\/g, '/').toLowerCase()
		)
	);
	const idePriority = boost.size ? 86 : 80;
	sources.push({
		kind: 'ide',
		priority: idePriority,
		content: [capabilities, ide.block, prefetch, lspOutline].filter(Boolean).join('\n\n'),
	});

	const f = factsSource(facts);
	if (f) sources.push(f);

	if (opts.sessionId) {
		try {
			const wiki = await getSessionWikiStore().load(opts.sessionId);
			const block = getSessionWikiStore().formatForPrompt(wiki);
			if (block) sources.push({ kind: 'wiki_session', priority: 90, content: block });
		} catch {
			/* ignore */
		}
	}

	try {
		const project = getProjectWikiStore();
		if (project.isReady()) {
			const block = project.formatForPrompt();
			if (block) sources.push({ kind: 'wiki_project', priority: 85, content: block });
		}
	} catch {
		/* ignore */
	}

	try {
		const status = await loadProjectStatus(opts.workspaceRoot);
		const liveRepo = await gatherRepoSnapshot(opts.workspaceRoot);
		sources.push({
			kind: 'status',
			priority: 96,
			content: status ? formatStatusForPrompt(status, { liveRepo }) : emptyStatusPrompt(),
		});
	} catch {
		/* ignore */
	}

	// Extended-memory lessons are attached to the failing shell output that triggers them,
	// not repeated in every packet.

	if (retrieved.length || retrieveNote) {
		const boosted = retrieved.filter(r =>
			boost.has(r.path.replace(/\\/g, '/').toLowerCase())
		);
		const rest = retrieved.filter(
			r => !boost.has(r.path.replace(/\\/g, '/').toLowerCase())
		);
		const ordered = [...boosted, ...rest];
		sources.push({
			kind: 'retrieve',
			priority: boosted.length ? 78 : 70,
			content: ['### RETRIEVE', retrieveNote, formatRetrievedBlock(ordered)]
				.filter(Boolean)
				.join('\n'),
		});
	}

	if (opts.historyText?.trim()) {
		sources.push({
			kind: 'history',
			priority: 40,
			content: `### RECENT CHAT\n${clipData(opts.historyText.trim(), 6000)}`,
		});
	}

	const budget = opts.budget ?? {
		...DEFAULT_BUDGET,
		total:
			vscode.workspace.getConfiguration('codeforge.ai').get<number>('contextBudget') ??
			DEFAULT_BUDGET.total,
	};

	const assembled = assembleContext(sources, budget);
	const openRel = ide.openRelative;
	const badge = contextBadge(
		facts.keyPaths,
		retrieved.map(r => r.path),
		openRel
	);

	return {
		markdown: [
			'## CONTEXT PACKET',
			assembled.markdown,
			`### CONTEXT BADGE\n${badge.indexed} indexed · ${badge.inContext} in context · sources: ${assembled.included.join(', ')}`,
		].join('\n\n'),
		retrieved,
		badge,
		included: assembled.included,
	};
}

async function gatherIdeState(): Promise<{
	block: string;
	openRelative?: string;
	/** Open / dirty editors — used to boost retrieve ranking. */
	editorPaths: string[];
	gitAvailable: boolean;
}> {
	const editor = vscode.window.activeTextEditor;
	const lines: string[] = ['### IDE STATE'];
	const editorPaths: string[] = [];

	let openRelative: string | undefined;
	if (editor) {
		const rel = vscode.workspace.asRelativePath(editor.document.uri);
		openRelative = rel;
		editorPaths.push(rel);
		lines.push(`- Open: ${rel} (${editor.document.languageId})`);
		const sel = editor.document.getText(editor.selection);
		if (sel.trim()) {
			lines.push(`- Selection:\n\`\`\`\n${sel.slice(0, 2000)}\n\`\`\``);
		}
	} else {
		lines.push('- Open: (none)');
	}

	const tabs = vscode.window.tabGroups.all
		.flatMap((g: vscode.TabGroup) => g.tabs)
		.map((t: vscode.Tab) => {
			const input = t.input as { uri?: vscode.Uri } | undefined;
			return input?.uri ? vscode.workspace.asRelativePath(input.uri) : undefined;
		})
		.filter((p): p is string => !!p);
	const dirty = vscode.workspace.textDocuments
		.filter((d: vscode.TextDocument) => d.isDirty && !d.isUntitled)
		.map((d: vscode.TextDocument) => vscode.workspace.asRelativePath(d.uri));
	for (const p of [...dirty, ...tabs]) {
		if (!editorPaths.includes(p)) editorPaths.push(p);
	}
	if (dirty.length) {
		lines.push(`- Dirty (recent edits): ${dirty.slice(0, 12).join(', ')}`);
	}
	if (tabs.length > 1) {
		lines.push(`- Open editors: ${tabs.slice(0, 12).join(', ')}`);
	}

	const diags = collectTopDiagnostics(15, editor?.document.uri);
	if (diags.length) {
		lines.push(`- Diagnostics (${diags.length}):`);
		for (const d of diags) {
			lines.push(`  · ${d}`);
		}
	} else {
		lines.push('- Diagnostics: none');
	}

	let gitAvailable = true;
	try {
		const status = await git.gitStatus();
		const short = status.split('\n').slice(0, 12).join(' | ');
		lines.push(`- Git: ${short.slice(0, 500)}`);
		const diff = await git.gitDiff();
		const snippet = diff.split('\n').slice(0, 20).join('\n');
		if (snippet && snippet !== '(empty)') {
			lines.push(`- Git diff (truncated):\n\`\`\`\n${snippet.slice(0, 1200)}\n\`\`\``);
		}
	} catch {
		gitAvailable = false;
		lines.push('- Git: (unavailable)');
	}

	return {
		block: lines.join('\n'),
		openRelative,
		editorPaths: editorPaths.slice(0, 24),
		gitAvailable,
	};
}

async function gatherToolCapabilities(
	workspaceRoot: string | undefined,
	gitAvailable: boolean
): Promise<string> {
	const indexed = getIndexedCount();
	const semantic = hasSemanticEmbeddings();
	return [
		'### TOOL CAPABILITIES',
		`- Workspace root: ${workspaceRoot || '(none — ask user to open a folder)'}`,
		`- Git: ${gitAvailable ? 'available' : 'unavailable (git_* tools will fail)'}`,
		`- Index: ${indexed} paths cached; retrieve is ${semantic ? 'hybrid lexical+semantic' : 'lexical-only (embeddings not ready)'}`,
	].join('\n');
}

async function gatherWorkspacePrefetch(workspaceRoot?: string): Promise<string> {
	const folder =
		workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) return '';
	const lines: string[] = ['### WORKSPACE PREFETCH'];
	try {
		const entries = await fs.readdir(folder, { withFileTypes: true });
		const all = entries
			.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
			.map(e => (e.isDirectory() ? `${e.name}/` : e.name));
		const names = all.slice(0, 24);
		if (names.length) {
			const more = all.length > names.length ? ` …[+${all.length - names.length} entries]` : '';
			lines.push(`- Top-level: ${names.join(', ')}${more}`);
		}
	} catch {
		return '';
	}
	const markers = [
		'package.json',
		'README.md',
		'README',
		'*.csproj',
		'*.sln',
		'Cargo.toml',
		'pyproject.toml',
		'go.mod',
	];
	const found: string[] = [];
	for (const m of markers) {
		if (m.includes('*')) {
			try {
				const hits = await vscode.workspace.findFiles(m, '**/node_modules/**', 4);
				for (const u of hits) {
					found.push(vscode.workspace.asRelativePath(u));
				}
			} catch {
				/* ignore */
			}
		} else {
			try {
				await fs.access(path.join(folder, m));
				found.push(m);
			} catch {
				/* missing */
			}
		}
	}
	if (found.length) {
		lines.push(`- Markers: ${[...new Set(found)].slice(0, 12).join(', ')}`);
	}
	return lines.length > 1 ? lines.join('\n') : '';
}

async function gatherActiveLspOutline(): Promise<string> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return '';
	try {
		const rel = vscode.workspace.asRelativePath(editor.document.uri);
		const symbols = await lsp.documentSymbols(editor.document.uri.fsPath);
		if (!symbols || symbols.startsWith('No symbols')) return '';
		const all = symbols.split('\n');
		const outline =
			all.slice(0, 40).join('\n') + (all.length > 40 ? `\n…[+${all.length - 40} symbols; use symbols tool]` : '');
		return [
			'### LSP OUTLINE (active file)',
			`File: ${rel}`,
			outline,
		].join('\n');
	} catch {
		return '';
	}
}

function collectTopDiagnostics(limit: number, prefer?: vscode.Uri): string[] {
	const all = vscode.languages.getDiagnostics();
	const scored: Array<{ score: number; line: string }> = [];
	for (const [uri, diags] of all) {
		const rel = vscode.workspace.asRelativePath(uri);
		const preferBoost = prefer && uri.toString() === prefer.toString() ? 10 : 0;
		for (const d of diags) {
			if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
			const sev = vscode.DiagnosticSeverity[d.severity];
			scored.push({
				score: preferBoost + (d.severity === vscode.DiagnosticSeverity.Error ? 5 : 1),
				line: `${rel}:${d.range.start.line + 1} [${sev}] ${d.message.slice(0, 160)}`,
			});
		}
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(s => s.line);
}

async function gatherRepoSnapshot(workspaceRoot?: string) {
	const folder =
		workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) return null;
	try {
		const [headRes, statusRes] = await Promise.all([
			execFileAsync('git', ['rev-parse', 'HEAD'], {
				cwd: folder,
				windowsHide: true,
				maxBuffer: 64 * 1024,
			}),
			execFileAsync('git', ['status', '--short', '--branch'], {
				cwd: folder,
				windowsHide: true,
				maxBuffer: 512 * 1024,
			}),
		]);
		return (
			parseRepoSnapshot({
				head: (headRes.stdout || '').trim(),
				statusShort: (statusRes.stdout || statusRes.stderr || '').trim(),
			}) ?? null
		);
	} catch {
		return null;
	}
}
