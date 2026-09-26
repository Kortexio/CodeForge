/**
 * Debounced workspace index + optional semantic embedding refresh.
 */

import * as vscode from 'vscode';
import {
	ensureWorkspaceIndex,
	indexEmbeddings,
} from './workspaceIndex';

const DEBOUNCE_MS = 5000;

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let embeddingInFlight = false;

function semanticIndexMode(): 'auto' | 'off' {
	const v = vscode.workspace.getConfiguration('codeforge.ai').get<string>('semanticIndex');
	return v === 'off' ? 'off' : 'auto';
}

export async function refreshWorkspaceIndex(opts?: {
	embeddings?: boolean;
}): Promise<{ indexed: number; embedded: number }> {
	const { indexed } = await ensureWorkspaceIndex();
	let embedded = 0;
	if (opts?.embeddings !== false && semanticIndexMode() === 'auto' && !embeddingInFlight) {
		embeddingInFlight = true;
		try {
			embedded = await indexEmbeddings(3000, false);
		} catch {
			embedded = 0;
		} finally {
			embeddingInFlight = false;
		}
	}
	return { indexed, embedded };
}

function scheduleRefresh(): void {
	if (semanticIndexMode() === 'off') return;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		void refreshWorkspaceIndex({ embeddings: true });
	}, DEBOUNCE_MS);
}

/** Start FileSystemWatcher + initial index. Returns disposables. */
export function startWorkspaceIndexWatcher(
	context: vscode.ExtensionContext
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	void refreshWorkspaceIndex({ embeddings: true });

	watcher?.dispose();
	watcher = vscode.workspace.createFileSystemWatcher(
		'**/*.{ts,tsx,js,jsx,cs,py,go,rs,md}'
	);
	disposables.push(watcher);
	disposables.push(watcher.onDidChange(() => scheduleRefresh()));
	disposables.push(watcher.onDidCreate(() => scheduleRefresh()));
	disposables.push(watcher.onDidDelete(() => scheduleRefresh()));
	disposables.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('codeforge.ai.semanticIndex')) {
				scheduleRefresh();
			}
		})
	);
	for (const d of disposables) {
		context.subscriptions.push(d);
	}
	return disposables;
}

export function stopWorkspaceIndexWatcherForTests(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = undefined;
	watcher?.dispose();
	watcher = undefined;
}
