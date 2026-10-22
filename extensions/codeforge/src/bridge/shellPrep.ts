/**
 * Normalize Windows shell commands (cd X && rest) before sandbox execution.
 */

import * as fs from 'fs';
import * as path from 'path';

export function isPathInsideWorkspace(workspaceRoot: string, absPath: string): boolean {
	const root = path.resolve(workspaceRoot);
	const target = path.resolve(absPath);
	const rel = path.relative(root, target);
	if (!rel || rel === '') return true;
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export type PreparedShellCommand =
	| {
			notRun: true;
			message: string;
	  }
	| {
			notRun?: false;
			command: string;
			cwd: string;
			display: string;
			note?: string;
	  };

/**
 * Prefer running under the right cwd instead of `cd path && …`.
 * Keeps && for cmd.exe chaining on Windows.
 */
export function prepareWindowsCommand(command: string, workspaceRoot: string): PreparedShellCommand {
	const pipeStripped = command
		.replace(/\s*\|\s*(tail|head|grep)\b[^|&;]*/gi, '')
		.trim();
	const pipeNote =
		pipeStripped !== command.trim()
			? 'Removed Unix pipe (tail/head/grep) — shell is cmd.exe.'
			: undefined;
	const trimmed = pipeStripped;
	const cdMatch = /^(?:cd(?:\s+\/d)?)\s+("([^"]+)"|([^\s&;]+))\s*(?:&&|;)\s*([\s\S]+)$/i.exec(
		trimmed
	);
	if (cdMatch) {
		const target = (cdMatch[2] || cdMatch[3] || '').trim();
		const rest = (cdMatch[4] || '').trim();
		if (target && rest) {
			const abs = path.isAbsolute(target) ? target : path.resolve(workspaceRoot, target);
			if (!fs.existsSync(abs) || !isPathInsideWorkspace(workspaceRoot, abs)) {
				return {
					notRun: true,
					message: `Not run: directory ${target} does not exist`,
				};
			}
			return {
				command: rest,
				cwd: abs,
				display: rest,
				note: [pipeNote, `normalized: cwd → ${abs}`].filter(Boolean).join(' | '),
			};
		}
	}

	return {
		command: trimmed,
		cwd: workspaceRoot,
		display: trimmed,
		note: pipeNote,
	};
}
