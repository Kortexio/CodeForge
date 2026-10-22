/**
 * Gate write/edit/delete/rename/apply_patch targets outside the workspace folder.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { isPathInsideWorkspace } from './shellPrep';

export type OutsideWorkspaceMode = 'ask' | 'allow' | 'deny';

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'delete', 'rename']);

export function isWriteTool(name: string): boolean {
	return WRITE_TOOLS.has(name.trim().toLowerCase());
}

export function resolveWorkspaceAbsolute(workspaceRoot: string | undefined, filePath: string): string {
	const p = String(filePath || '').trim();
	if (!p) return '';
	if (path.isAbsolute(p)) return path.resolve(p);
	if (!workspaceRoot) return path.resolve(p);
	return path.resolve(workspaceRoot, p);
}

export function pathsOutsideWorkspace(
	workspaceRoot: string | undefined,
	paths: string[]
): string[] {
	if (!workspaceRoot) return [];
	const out: string[] = [];
	for (const p of paths) {
		const abs = resolveWorkspaceAbsolute(workspaceRoot, p);
		if (!abs) continue;
		if (!isPathInsideWorkspace(workspaceRoot, abs)) {
			out.push(p);
		}
	}
	return out;
}

export function readOutsideWorkspaceMode(): OutsideWorkspaceMode {
	const raw = vscode.workspace.getConfiguration('codeforge.ai').get<string>('outsideWorkspaceWrites', 'ask');
	return raw === 'allow' || raw === 'deny' ? raw : 'ask';
}

export function allowAllApprovalsEnabled(): boolean {
	const cfg = vscode.workspace.getConfiguration('codeforge.ai');
	if (cfg.get<boolean>('allowAll') === true) return true;
	if (cfg.get<boolean>('fullAgentFreedom') === true) return true;
	return false;
}

export async function assertWorkspaceWriteAllowed(
	tool: string,
	paths: string[],
	workspaceRoot: string | undefined
): Promise<void> {
	if (!isWriteTool(tool)) return;
	const outside = pathsOutsideWorkspace(workspaceRoot, paths);
	if (!outside.length) return;

	if (allowAllApprovalsEnabled()) {
		return;
	}

	const mode = readOutsideWorkspaceMode();
	if (mode === 'allow') return;
	if (mode === 'deny') {
		throw new Error(
			`Outside workspace writes are denied (${outside.join(', ')}). Change codeforge.ai.outsideWorkspaceWrites or use paths under the workspace root.`
		);
	}

	const picked = await vscode.window.showWarningMessage(
		`Allow ${tool} outside the workspace?\n${outside.join('\n')}`,
		{ modal: true },
		'Allow once',
		'Deny'
	);
	if (picked !== 'Allow once') {
		throw new Error(`Denied: ${tool} outside workspace (${outside.join(', ')})`);
	}
}
