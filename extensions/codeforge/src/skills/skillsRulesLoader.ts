/**
 * Load Skills and Rules from disk (.CodeForge / ~/.CodeForge / resources).
 * Supports Cursor-like .mdc / .md with YAML frontmatter (globs, alwaysApply, paths).
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
	/** Source file — offered to the model when only the description fits. */
	filePath?: string;
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
	filePath?: string;
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
		// Safety / build-loop defaults live in governance builtins; disk rules only add to them.
		this.rules = [];

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
		return matchSkills(this.skills, query);
	}

	/** Cookbook lines (`- CS0246 …`) for the given error codes, from any loaded skill. */
	cookbookHints(codes: string[]): string[] {
		return cookbookLines(this.skills, codes);
	}

	/** Rules that always apply, or match any of the given relative/absolute paths. */
	activeRules(filePaths: string[] = []): RuleDoc[] {
		const normPaths = filePaths.map(normalizePath);
		return this.rules.filter(r => {
			if (r.alwaysApply) return true;
			if (!r.globs.length) return false;
			return normPaths.some(p => r.globs.some(g => matchGlob(g, p)));
		});
	}

	buildPromptSection(task: string, filePaths: string[] = [], charBudget = 3500): string {
		return buildDiskPromptSection(
			this.matchingSkills(task).slice(0, 3),
			this.activeRules(filePaths).slice(0, 12),
			charBudget
		);
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
						filePath: path.join(dir, name),
					});
				} else {
					const declaredPaths =
						parsed.meta.globs !== undefined || parsed.meta.paths !== undefined;
					const globs = parseGlobs(parsed.meta.globs ?? parsed.meta.paths);
					let alwaysApply =
						parsed.meta.alwaysApply === true || parsed.meta.alwaysApply === 'true';
					if (
						!alwaysApply &&
						parsed.meta.alwaysApply !== false &&
						parsed.meta.alwaysApply !== 'false'
					) {
						// Only promote to alwaysApply when no path filter was declared.
						alwaysApply = !declaredPaths && globs.length === 0;
					}
					if (declaredPaths && globs.length === 0) {
						console.warn(
							`[CodeForge] rule "${title}" declared globs/paths but none parsed — leaving inactive`
						);
						alwaysApply = false;
					}
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
						filePath: path.join(dir, name),
					});
				}
			} catch {
				/* skip */
			}
		}
	}
}

/** Strip BOM and parse simple YAML frontmatter (inline + block lists). */
export function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
	const text = raw.replace(/^\uFEFF/, '');
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) {
		return { meta: {}, body: text.trim() };
	}
	const meta: Record<string, unknown> = {};
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		if (!key || key.startsWith('#')) continue;
		let valRaw = line.slice(idx + 1).trim();

		// Block list: key:\n  - a\n  - b
		if (!valRaw) {
			const items: string[] = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1];
				const listItem = /^\s*-\s+(.*)$/.exec(next);
				if (!listItem) break;
				i += 1;
				items.push(unquote(listItem[1].trim()));
			}
			if (items.length) {
				meta[key] = items;
				continue;
			}
			meta[key] = '';
			continue;
		}

		if (valRaw === 'true') {
			meta[key] = true;
		} else if (valRaw === 'false') {
			meta[key] = false;
		} else if (
			(valRaw.startsWith('"') && valRaw.endsWith('"')) ||
			(valRaw.startsWith("'") && valRaw.endsWith("'"))
		) {
			meta[key] = valRaw.slice(1, -1);
		} else if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
			meta[key] = splitInlineList(valRaw.slice(1, -1));
		} else {
			meta[key] = valRaw;
		}
	}
	return { meta, body: m[2].trim() };
}

export function parseGlobs(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.map(String).map(s => s.trim()).filter(Boolean);
	}
	if (typeof raw === 'string' && raw.trim()) {
		const t = raw.trim();
		if (t.startsWith('[') && t.endsWith(']')) {
			return splitInlineList(t.slice(1, -1));
		}
		return [t];
	}
	return [];
}

/** Split CSV-like list respecting braces {a,b} and quotes. */
export function splitInlineList(raw: string): string[] {
	const out: string[] = [];
	let cur = '';
	let depth = 0;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (quote) {
			if (c === quote && raw[i - 1] !== '\\') quote = null;
			cur += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			cur += c;
			continue;
		}
		if (c === '{') {
			depth += 1;
			cur += c;
			continue;
		}
		if (c === '}') {
			depth = Math.max(0, depth - 1);
			cur += c;
			continue;
		}
		if (c === ',' && depth === 0) {
			const item = unquote(cur.trim());
			if (item) out.push(item);
			cur = '';
			continue;
		}
		cur += c;
	}
	const last = unquote(cur.trim());
	if (last) out.push(last);
	return out;
}

function unquote(s: string): string {
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		return s.slice(1, -1);
	}
	return s;
}

function extractTriggers(
	content: string,
	title: string,
	meta: Record<string, unknown>
): string[] {
	// Only explicit triggers and the title: description words matched almost every request.
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

function phraseRegex(phrase: string): RegExp {
	const esc = phrase.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
	return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

/** Skills whose title or an explicit trigger appears in the request as a whole word/phrase. */
export function matchSkills(skills: SkillDoc[], query: string): SkillDoc[] {
	const q = query.toLowerCase();
	return skills.filter(s => s.triggers.some(t => t.trim().length >= 2 && phraseRegex(t).test(q)));
}

/** `- CODE …` lines for the given codes (first match per code). */
export function cookbookLines(skills: SkillDoc[], codes: string[]): string[] {
	const out: string[] = [];
	for (const code of [...new Set(codes.map(c => c.toUpperCase()))]) {
		const re = new RegExp(`^\\s*[-*]\\s*\\**${code}\\b`, 'i');
		for (const s of skills) {
			const line = s.content.split(/\r?\n/).find(l => re.test(l));
			if (line) {
				out.push(line.trim().replace(/^[-*]\s*/, ''));
				break;
			}
		}
	}
	return out;
}

/**
 * Disk rules + skills for the prompt. Instruction blocks are never cut: each goes in whole,
 * or as its description plus the file to `read` for the full text, or is left out.
 */
export function buildDiskPromptSection(
	skills: SkillDoc[],
	rules: RuleDoc[],
	charBudget: number
): string {
	let remaining = charBudget;
	const take = (full: string, short: string): string => {
		const pick = full.length <= remaining ? full : short && short.length <= remaining ? short : '';
		if (pick) remaining -= pick.length + 1;
		return pick;
	};
	const pointer = (p?: string) => (p ? ` (full text: read \`${p}\`)` : '');
	const ruleLines = rules
		.map(r =>
			take(
				`- ${r.title}: ${r.content.trim()}`,
				r.description ? `- ${r.title}: ${r.description.trim()}${pointer(r.filePath)}` : ''
			)
		)
		.filter(Boolean);
	const skillBlocks = skills
		.map(s =>
			take(
				`### ${s.title}\n${s.content.trim()}`,
				`### ${s.title}\n${(s.description || s.triggers.slice(1, 6).join(', ')).trim()}${pointer(s.filePath)}`
			)
		)
		.filter(Boolean);
	const parts: string[] = [];
	if (ruleLines.length) parts.push('## Disk Rules', ...ruleLines);
	if (skillBlocks.length) parts.push('## Relevant Disk Skills', ...skillBlocks);
	return parts.join('\n');
}

/** Minimal glob: **, *, ?, and {a,b} brace expansion. */
export function matchGlob(pattern: string, filePath: string): boolean {
	const pat = normalizePath(pattern);
	const fp = normalizePath(filePath);
	const candidates = [fp, fp.replace(/^\/+/, ''), path.posix.basename(fp)];
	for (const expanded of expandBraces(pat)) {
		const rx = globToRegExp(expanded);
		if (candidates.some(c => rx.test(c))) return true;
	}
	return false;
}

export function expandBraces(glob: string): string[] {
	const m = /\{([^{}]+)\}/.exec(glob);
	if (!m) return [glob];
	const alts = m[1].split(',').map(s => s.trim()).filter(Boolean);
	const out: string[] = [];
	for (const alt of alts) {
		const next = glob.slice(0, m.index) + alt + glob.slice(m.index! + m[0].length);
		out.push(...expandBraces(next));
	}
	return out.length ? out : [glob];
}

export function globToRegExp(glob: string): RegExp {
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
		if ('.()+|^$[]{}!'.includes(c)) {
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
