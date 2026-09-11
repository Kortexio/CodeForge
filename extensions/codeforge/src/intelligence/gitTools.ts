/**
 * Git intelligence tools (status, diff, log, blame, conflicts, commit message).
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function root(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		throw new Error('No workspace folder open');
	}
	return folder;
}

async function git(args: string[]): Promise<string> {
	const { stdout, stderr } = await execFileAsync('git', args, {
		cwd: root(),
		maxBuffer: 2 * 1024 * 1024,
		windowsHide: true,
	});
	return (stdout || stderr || '').trim() || '(empty)';
}

export async function gitStatus(): Promise<string> {
	return git(['status', '--short', '--branch']);
}

export async function gitDiff(pathFilter?: string): Promise<string> {
	const args = ['diff', '--stat'];
	if (pathFilter) {
		args.push('--', pathFilter);
	}
	const stat = await git(args);
	const fullArgs = ['diff'];
	if (pathFilter) {
		fullArgs.push('--', pathFilter);
	}
	const full = await git(fullArgs);
	const clipped = full.length > 15000 ? full.slice(0, 15000) + '\n…[truncated]' : full;
	return `${stat}\n\n${clipped}`;
}

export async function gitLog(count = 10): Promise<string> {
	return git(['log', `-${Math.min(50, Math.max(1, count))}`, '--oneline', '--decorate']);
}

export async function suggestCommitMessage(diffHint?: string): Promise<string> {
	const status = await gitStatus();
	const diff = diffHint ?? (await git(['diff', '--stat', 'HEAD']));
	const lines = status.split('\n').filter(Boolean);
	const files = lines
		.filter(l => !l.startsWith('##'))
		.map(l => l.replace(/^..\s+/, '').trim())
		.slice(0, 8);
	const scope = files[0]?.split(/[\\/]/)[0] ?? 'repo';
	const summary =
		files.length === 1
			? `update ${files[0]}`
			: files.length > 1
				? `update ${files.length} files in ${scope}`
				: 'update project';
	return [
		`Suggested commit message:`,
		``,
		`chore(${scope}): ${summary}`,
		``,
		`Based on:`,
		status,
		``,
		diff.slice(0, 2000),
	].join('\n');
}

export async function gitBlame(filePath: string, startLine?: number, endLine?: number): Promise<string> {
	const args = ['blame', '--line-porcelain'];
	if (startLine !== undefined) {
		const end = endLine ?? startLine;
		args.push('-L', `${startLine},${end}`);
	}
	args.push('--', filePath);
	const out = await git(args);
	return out.length > 12_000 ? out.slice(0, 12_000) + '\n…[truncated]' : out;
}

export interface MergeConflict {
	filePath: string;
	startLine: number;
	endLine: number;
	ours: string;
	theirs: string;
	base?: string;
}

export function parseMergeConflicts(filePath: string, content: string): MergeConflict[] {
	const conflicts: MergeConflict[] = [];
	const lines = content.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		if (lines[i].startsWith('<<<<<<<')) {
			const startLine = i + 1;
			let ours = '';
			let theirs = '';
			let base: string | undefined;
			let inOurs = true;
			let inBase = false;
			i++;
			while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
				if (lines[i].startsWith('|||||||')) {
					inOurs = false;
					inBase = true;
				} else if (lines[i].startsWith('=======')) {
					inBase = false;
					inOurs = false;
				} else if (inOurs) {
					ours += lines[i] + '\n';
				} else if (inBase) {
					base = (base ?? '') + lines[i] + '\n';
				} else {
					theirs += lines[i] + '\n';
				}
				i++;
			}
			conflicts.push({
				filePath,
				startLine,
				endLine: i + 1,
				ours: ours.trimEnd(),
				theirs: theirs.trimEnd(),
				base: base?.trimEnd(),
			});
		}
		i++;
	}
	return conflicts;
}

export async function gitConflicts(pathFilter?: string): Promise<string> {
	const status = await git(['status', '--short']);
	const unmerged = status
		.split('\n')
		.filter(l => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(l))
		.map(l => l.replace(/^..\s+/, '').trim())
		.filter(Boolean);
	const targets = pathFilter
		? unmerged.filter(p => p.replace(/\\/g, '/').includes(pathFilter.replace(/\\/g, '/')))
		: unmerged;

	// Also scan working tree for conflict markers if status empty
	let files = targets;
	if (!files.length) {
		try {
			const grep = await git(['grep', '-l', '^<<<<<<<', '--', pathFilter || '.']);
			files = grep === '(empty)' ? [] : grep.split('\n').filter(Boolean);
		} catch {
			files = [];
		}
	}

	if (!files.length) {
		return 'No merge conflicts detected.';
	}

	const parts: string[] = [`Conflict files (${files.length}):`];
	for (const file of files.slice(0, 12)) {
		try {
			const full = path.isAbsolute(file) ? file : path.join(root(), file);
			const content = await fs.readFile(full, 'utf8');
			const conflicts = parseMergeConflicts(file, content);
			parts.push(`\n## ${file} — ${conflicts.length} conflict(s)`);
			for (const c of conflicts.slice(0, 5)) {
				parts.push(
					`### lines ${c.startLine}-${c.endLine}`,
					'ours:\n```\n' + c.ours.slice(0, 1500) + '\n```',
					'theirs:\n```\n' + c.theirs.slice(0, 1500) + '\n```'
				);
			}
		} catch (err) {
			parts.push(`\n## ${file}\n(error: ${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return parts.join('\n');
}

export async function applyConflictResolution(
	filePath: string,
	resolvedContent: string
): Promise<string> {
	const full = path.isAbsolute(filePath) ? filePath : path.join(root(), filePath);
	await fs.writeFile(full, resolvedContent, 'utf8');
	await git(['add', '--', filePath]);
	return `Wrote resolution to ${filePath} and staged with git add`;
}
