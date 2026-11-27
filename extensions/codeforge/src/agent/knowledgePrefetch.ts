/**
 * Evidence before the first reply: repository hits, or a web search of the task
 * when the repo does not cover it. The query is the task text (no intent classifier).
 */

import * as vscode from 'vscode';
import { retrieveSnippets, type RetrieveHit } from '../intelligence/workspaceIndex';
import { clipData } from './clip';
import { webSearch } from './webTools';

export const USEFUL_RETRIEVE_SCORE = 0.05;
const RETRIEVE_CHARS = 3500;
const WEB_CHARS = 2500;

export function selectUsefulHits(hits: RetrieveHit[]): RetrieveHit[] {
	return hits.filter(h => (h.score ?? 1) > USEFUL_RETRIEVE_SCORE && h.text.trim().length > 0);
}

export function knowledgePrefetchEnabled(): boolean {
	try {
		return vscode.workspace.getConfiguration('codeforge.ai').get<boolean>('knowledgePrefetch') !== false;
	} catch {
		return true;
	}
}

export function formatRepoHits(hits: RetrieveHit[]): string {
	const lines = ['### REPO EVIDENCE'];
	let used = lines[0].length;
	for (const h of hits) {
		const end = h.endLine ?? h.startLine;
		const block = `#### ${h.path}:${h.startLine}-${end} score=${(h.score ?? 0).toFixed(3)}\n${h.text.slice(0, 500)}`;
		if (used + block.length > RETRIEVE_CHARS) break;
		lines.push(block);
		used += block.length;
	}
	return lines.join('\n');
}

export async function buildKnowledgeMarkdown(opts: {
	task: string;
	enabled?: boolean;
	retrieve?: (query: string, k: number) => Promise<RetrieveHit[]>;
	search?: (query: string, maxResults?: number) => Promise<string>;
}): Promise<{ markdown: string; usedWeb: boolean; repoHits: number }> {
	const enabled = opts.enabled ?? knowledgePrefetchEnabled();
	if (!enabled) return { markdown: '', usedWeb: false, repoHits: 0 };
	const task = opts.task.trim();
	if (!task) return { markdown: '', usedWeb: false, repoHits: 0 };

	const retrieve = opts.retrieve ?? ((query, k) => retrieveSnippets(query, k));
	let hits: RetrieveHit[] = [];
	try {
		hits = selectUsefulHits(await retrieve(task, 6));
	} catch {
		hits = [];
	}
	if (hits.length) {
		return { markdown: formatRepoHits(hits), usedWeb: false, repoHits: hits.length };
	}

	const search = opts.search ?? webSearch;
	let web = '';
	try {
		web = await search(task.slice(0, 400), 5);
	} catch (err) {
		web = `Error: web prefetch failed: ${err instanceof Error ? err.message : String(err)}`;
	}
	return {
		markdown: [
			'### WEB EVIDENCE',
			'No useful repository snippets for this task. Public search for the task text:',
			clipData(web, WEB_CHARS),
			'If this does not support the fact, call web_search with a more specific query and web_fetch one result. Do not invent APIs, versions, or external behavior.',
		].join('\n'),
		usedWeb: true,
		repoHits: 0,
	};
}
