/**
 * Spill clipped tool output to `.CodeForge/tool-output/` so the model can
 * read the full path later instead of re-running the command.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';

export const TOOL_OUTPUT_DIR_REL = '.CodeForge/tool-output';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function toolOutputDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.CodeForge', 'tool-output');
}

async function ensureDir(workspaceRoot: string): Promise<string> {
	const dir = toolOutputDir(workspaceRoot);
	await fs.mkdir(dir, { recursive: true });
	const gitignore = path.join(dir, '.gitignore');
	try {
		await fs.access(gitignore);
	} catch {
		await fs.writeFile(gitignore, '*\n!.gitignore\n', 'utf8');
	}
	return dir;
}

export async function spillToolOutput(
	workspaceRoot: string | undefined,
	fullText: string,
	opts?: { toolName?: string }
): Promise<string | undefined> {
	if (!workspaceRoot || !fullText) return undefined;
	try {
		const dir = await ensureDir(workspaceRoot);
		const id = randomBytes(6).toString('hex');
		const name = `tool_${opts?.toolName ? opts.toolName.replace(/[^\w.-]+/g, '_') + '_' : ''}${id}.txt`;
		const abs = path.join(dir, name);
		await fs.writeFile(abs, fullText, 'utf8');
		const rel = path.join('.CodeForge', 'tool-output', name).replace(/\\/g, '/');
		return rel;
	} catch {
		return undefined;
	}
}

/** Delete spill files older than 7 days (best-effort). */
export async function cleanupToolOutputSpill(workspaceRoot: string | undefined): Promise<number> {
	if (!workspaceRoot) return 0;
	const dir = toolOutputDir(workspaceRoot);
	let removed = 0;
	try {
		const entries = await fs.readdir(dir);
		const now = Date.now();
		for (const entry of entries) {
			if (entry === '.gitignore') continue;
			const abs = path.join(dir, entry);
			try {
				const st = await fs.stat(abs);
				if (now - st.mtimeMs > RETENTION_MS) {
					await fs.unlink(abs);
					removed++;
				}
			} catch {
				/* skip */
			}
		}
	} catch {
		/* no dir */
	}
	return removed;
}

/**
 * Clip text and, when clipped, append a spill path marker.
 * Returns the clipped text (possibly with spill marker).
 */
export async function clipWithSpill(
	workspaceRoot: string | undefined,
	toolName: string,
	text: string,
	max: number,
	clipFn: (name: string, t: string, m: number) => string
): Promise<string> {
	const t = String(text ?? '');
	if (t.length <= max) return t;
	const clipped = clipFn(toolName, t, max);
	const spillPath = await spillToolOutput(workspaceRoot, t, { toolName });
	if (!spillPath) return clipped;
	if (/full output saved to/i.test(clipped)) return clipped;
	return `${clipped}\n…[full output saved to ${spillPath}]`;
}
