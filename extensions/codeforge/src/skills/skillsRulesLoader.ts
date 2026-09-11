/**
 * Load Skills and Rules from disk (.CodeForge / ~/.CodeForge / resources).
 * Supports Cursor-like .mdc / .md with YAML frontmatter (globs, alwaysApply).
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface SkillDoc {
	id: string;
	scope: 'global' | 'workspace' | 'folder';
	title: string;
	content: string;
	triggers: string[];
	description?: string;
}

export interface RuleDoc {
	id: string;
	scope: 'system' | 'user' | 'workspace' | 'folder';
	title: string;
	content: string;
	description?: string;
	/** Glob patterns (minimatch-lite); empty = no path filter when alwaysApply. */
	globs: string[];
	alwaysApply: boolean;
}

export class SkillsRulesLoader {
	private skills: SkillDoc[] = [];
	private rules: RuleDoc[] = [];

	listSkills(): SkillDoc[] {
		return [...this.skills];
	}

	listRules(): RuleDoc[] {
		return [...this.rules];
	}

	async reload(extensionPath?: string): Promise<void> {
		this.skills = [];
		this.rules = [
			{
				id: 'system-default',
				scope: 'system',
				title: 'System',
				content:
					'Prefer relative paths. Ask before destructive shell. Do not invent APIs. Prefer small safe edits.',
				globs: [],
				alwaysApply: true,
			},
		];

		if (extensionPath) {
			await this.loadDir(path.join(extensionPath, 'resources', 'skills'), 'global', 'skill');
			await this.loadDir(path.join(extensionPath, 'resources', 'rules'), 'system', 'rule');
		}

		const home = path.join(os.homedir(), '.CodeForge');
		await this.loadDir(path.join(home, 'skills'), 'global', 'skill');
		await this.loadDir(path.join(home, 'rules'), 'user', 'rule');

		const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (ws) {
			await this.loadDir(path.join(ws, '.opencode', 'skills'), 'workspace', 'skill');
			await this.loadDir(path.join(ws, '.opencode', 'rules'), 'workspace', 'rule');
			await this.loadDir(path.join(ws, '.CodeForge', 'skills'), 'workspace', 'skill');
			await this.loadDir(path.join(ws, '.CodeForge', 'rules'), 'workspace', 'rule');
		}
	}

	matchingSkills(query: string): SkillDoc[] {
		const q = query.toLowerCase();
		return this.skills.filter(
			s =>
				s.triggers.some(t => q.includes(t.toLowerCase())) ||
				s.title.toLowerCase().includes(q) ||
				s.content.toLowerCase().includes(q)
		);
	}

	/** Rules that always apply, or match any of the given relative/absolute paths. */
	activeRules(filePaths: string[] = []): RuleDoc[] {
		const normPaths = filePaths.map(normalizePath);
		return this.rules.filter(r => {
			if (r.alwaysApply || !r.globs.length) {
				return r.alwaysApply || !r.globs.length;
			}
			return normPaths.some(p => r.globs.some(g => matchGlob(g, p)));
		});
	}

	buildPromptSection(task: string, filePaths: string[] = []): string {
		const matched = this.matchingSkills(task).slice(0, 3);
		const rules = this.activeRules(filePaths).slice(0, 12);
		const parts: string[] = [];
		if (rules.length) {
			parts.push(
				'## Disk Rules (.CodeForge)',
				...rules.map(r => {
					const meta = [
						r.alwaysApply ? 'always' : '',
						r.globs.length ? `globs:${r.globs.join(',')}` : '',
					]
						.filter(Boolean)
						.join(' ');
					return `- [${r.scope}] ${r.title}${meta ? ` (${meta})` : ''}: ${r.content.slice(0, 500)}`;
				})
			);
		}
		if (matched.length) {
			parts.push(
				'## Relevant Disk Skills',
				...matched.map(s => `### ${s.title}\n${s.content.slice(0, 2000)}`)
			);
		}
		return parts.join('\n');
	}

	private async loadDir(
		dir: string,
		scope: SkillDoc['scope'] | RuleDoc['scope'],
		kind: 'skill' | 'rule'
	): Promise<void> {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const lower = name.toLowerCase();
			if (!lower.endsWith('.md') && !lower.endsWith('.mdc')) continue;
			try {
				const raw = await fs.readFile(path.join(dir, name), 'utf8');
				const parsed = parseFrontmatter(raw);
				const title =
					(typeof parsed.meta.name === 'string' && parsed.meta.name) ||
					(typeof parsed.meta.title === 'string' && parsed.meta.title) ||
					name.replace(/\.(mdc|md)$/i, '');
				if (kind === 'skill') {
					this.skills.push({
						id: `${scope}:${title}`,
						scope: scope as SkillDoc['scope'],
						title,
						content: parsed.body,
						description:
							typeof parsed.meta.description === 'string'
								? parsed.meta.description
								: undefined,
						triggers: extractTriggers(parsed.body, title, parsed.meta),
					});
				} else {
					const globs = parseGlobs(parsed.meta.globs);
					const alwaysApply =
						parsed.meta.alwaysApply === true ||
						parsed.meta.alwaysApply === 'true' ||
						(globs.length === 0 && parsed.meta.alwaysApply !== false);
					this.rules.push({
						id: `${scope}:${title}`,
						scope: scope as RuleDoc['scope'],
						title,
						content: parsed.body,
						description:
							typeof parsed.meta.description === 'string'
								? parsed.meta.description
								: undefined,
						globs,
						alwaysApply,
					});
				}
			} catch {
				/* skip */
			}
		}
	}
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) {
		return { meta: {}, body: raw.trim() };
	}
	const meta: Record<string, unknown> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let val: unknown = line.slice(idx + 1).trim();
		if (val === 'true') val = true;
		else if (val === 'false') val = false;
		else if (
			typeof val === 'string' &&
			((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
		) {
			val = val.slice(1, -1);
		} else if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
			val = val
				.slice(1, -1)
				.split(',')
				.map(s => s.trim().replace(/^["']|["']$/g, ''))
				.filter(Boolean);
		}
		meta[key] = val;
	}
	return { meta, body: m[2].trim() };
}

function parseGlobs(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.map(String).filter(Boolean);
	}
	if (typeof raw === 'string' && raw.trim()) {
		if (raw.trim().startsWith('[')) {
			return raw
				.replace(/^\[|\]$/g, '')
				.split(',')
				.map(s => s.trim().replace(/^["']|["']$/g, ''))
				.filter(Boolean);
		}
		return [raw.trim()];
	}
	return [];
}

function extractTriggers(
	content: string,
	title: string,
	meta: Record<string, unknown>
): string[] {
	const triggers = [title];
	if (Array.isArray(meta.triggers)) {
		triggers.push(...meta.triggers.map(String));
	}
	const match = content.match(/^triggers:\s*\[([^\]]+)\]/im);
	if (match) {
		triggers.push(
			...match[1]
				.split(',')
				.map(s => s.trim().replace(/^["']|["']$/g, ''))
				.filter(Boolean)
		);
	}
	return Array.from(new Set(triggers.filter(Boolean)));
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

/** Minimal glob: ** / *, ?, and suffix/prefix. */
function matchGlob(pattern: string, filePath: string): boolean {
	const pat = normalizePath(pattern);
	const fp = normalizePath(filePath);
	const rel = fp.includes('/') ? fp : fp;
	// Also try matching against basename and full path
	const candidates = [rel, rel.replace(/^\/+/, ''), path.posix.basename(rel)];
	const rx = globToRegExp(pat);
	return candidates.some(c => rx.test(c));
}

function globToRegExp(glob: string): RegExp {
	let s = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			s += '.*';
			i++;
			if (glob[i + 1] === '/') i++;
			continue;
		}
		if (c === '*') {
			s += '[^/]*';
			continue;
		}
		if (c === '?') {
			s += '[^/]';
			continue;
		}
		if ('\.()+|^$[]{}!'.includes(c)) {
			s += '\\' + c;
			continue;
		}
		s += c;
	}
	return new RegExp(`^${s}$`, 'i');
}

let shared: SkillsRulesLoader | undefined;

export function getSkillsRules(): SkillsRulesLoader {
	if (!shared) {
		shared = new SkillsRulesLoader();
	}
	return shared;
}
