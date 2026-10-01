/**
 * Lean first-call context — env + status one-liner + open file (OpenCode-style).
 * Full CONTEXT PACKET is assembled later when the run needs it.
 */

import * as vscode from 'vscode';
import { clipData } from './clip';
import { loadProjectStatus } from './projectStatus';

export interface LeanBootstrapOpts {
	workspaceRoot?: string;
	model?: string;
}

export interface LeanBootstrapResult {
	markdown: string;
	badge: { indexed: number; inContext: number };
}

/** Short environment + handoff block for the first LLM round. */
export async function buildLeanContextPacket(
	opts: LeanBootstrapOpts
): Promise<LeanBootstrapResult> {
	const root = opts.workspaceRoot?.trim() || '(none — ask user to open a folder)';
	const editor = vscode.window.activeTextEditor;
	const openRel = editor
		? vscode.workspace.asRelativePath(editor.document.uri)
		: '(none)';

	let statusLine = 'Status: (none yet — call update_status before the final reply)';
	try {
		const file = await loadProjectStatus(opts.workspaceRoot);
		if (file?.current) {
			const c = file.current;
			const bits = [
				c.objective ? `objective=${clipData(c.objective, 120)}` : '',
				c.stoppedAt ? `stoppedAt=${clipData(c.stoppedAt, 160)}` : '',
				c.next ? `next=${clipData(c.next, 120)}` : '',
			].filter(Boolean);
			if (bits.length) {
				statusLine = `Status: ${bits.join(' · ')}`;
			}
		}
	} catch {
		/* ignore */
	}

	const markdown = [
		'## CONTEXT',
		`- Workspace: ${root}`,
		`- Platform: Windows (${process.platform})`,
		opts.model ? `- Model: ${opts.model}` : '',
		`- Date: ${new Date().toISOString().slice(0, 10)}`,
		`- Open file: ${openRel}`,
		`- ${statusLine}`,
		'Use retrieve/search/read for repo context. Call skill for playbooks. Call update_status before the final reply.',
	]
		.filter(Boolean)
		.join('\n');

	return {
		markdown,
		badge: { indexed: 0, inContext: 0 },
	};
}
