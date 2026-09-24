/**
 * Canonical session facts that survive LLM compaction.
 */

export interface StableFacts {
	projectRoots: string[];
	keyPaths: string[];
	stackHints: string[];
	decisions: string[];
	openErrors: string[];
	updatedAt: number;
}

export function emptyStableFacts(): StableFacts {
	return {
		projectRoots: [],
		keyPaths: [],
		stackHints: [],
		decisions: [],
		openErrors: [],
		updatedAt: Date.now(),
	};
}

export function normalizeFacts(input?: Partial<StableFacts> | null): StableFacts {
	const base = emptyStableFacts();
	if (!input) return base;
	return {
		projectRoots: uniq(input.projectRoots ?? []),
		keyPaths: uniq((input.keyPaths ?? []).filter(isPlausiblePath)),
		stackHints: uniq(input.stackHints ?? []),
		decisions: uniq(input.decisions ?? []).slice(-20),
		openErrors: uniq(input.openErrors ?? []).slice(-30),
		updatedAt: input.updatedAt ?? Date.now(),
	};
}

/** Rejects prose that leaked into keyPaths (e.g. ADVICE sentences parsed as list entries). */
export function isPlausiblePath(p: string): boolean {
	const s = String(p ?? '').trim();
	if (!s || s.length > 260 || s.includes('###')) return false;
	if (/\b(ADVICE|Prefer|explore tools|CONTEXT PACKET)\b/.test(s)) return false;
	const last = s.split(/[\\/]/).pop() ?? s;
	if (last.split(/\s+/).length > 4) return false;
	if (/\s/.test(last) && /[.!?:,]$/.test(last)) return false;
	return true;
}

export function mergeStableFacts(prev: StableFacts | undefined, next: Partial<StableFacts>): StableFacts {
	const a = normalizeFacts(prev);
	// openErrors: replace when explicitly provided (including empty = clear)
	const openErrors =
		next.openErrors !== undefined
			? uniq(next.openErrors).slice(-30)
			: a.openErrors;
	return {
		projectRoots: uniq([...a.projectRoots, ...(next.projectRoots ?? [])]).slice(0, 12),
		keyPaths: uniq([...a.keyPaths, ...(next.keyPaths ?? []).filter(isPlausiblePath)]).slice(0, 80),
		stackHints: uniq([...a.stackHints, ...(next.stackHints ?? [])]).slice(0, 20),
		decisions: uniq([...a.decisions, ...(next.decisions ?? [])]).slice(-20),
		openErrors,
		updatedAt: Date.now(),
	};
}

/** Extract / update facts from a tool call result. */
export function extractFactsFromTool(
	prev: StableFacts | undefined,
	tool: string,
	args: Record<string, unknown>,
	output: string,
	success: boolean,
	workspaceRoot?: string
): StableFacts {
	let facts = normalizeFacts(prev);
	const root = workspaceRoot?.replace(/[/\\]+$/, '');

	if (root && !facts.projectRoots.some(p => eqPath(p, root))) {
		facts = mergeStableFacts(facts, { projectRoots: [root] });
	}

	const pathArg = firstPath(args);
	if (pathArg) {
		facts = mergeStableFacts(facts, { keyPaths: [toRel(pathArg, root)] });
		const projectHint = detectProjectRoot(pathArg, root);
		if (projectHint) {
			facts = mergeStableFacts(facts, { projectRoots: [projectHint] });
		}
	}

	if (tool === 'list' && success) {
		const children: string[] = [];
		for (const raw of output.split('\n')) {
			const l = raw.trim();
			// Advice / memory blocks appended to tool output start with markdown headings.
			if (l.startsWith('#')) break;
			if (!l || l.startsWith('(')) continue;
			children.push(l);
			if (children.length >= 40) break;
		}
		const base = pathArg ? toRel(String(pathArg), root) : '.';
		const childPaths = children.map(c => {
			const name = c.replace(/^[\[\]\w\s]+\s+/, '').trim() || c;
			return base === '.' ? name : `${base.replace(/\\/g, '/')}/${name}`.replace(/\/+/g, '/');
		});
		facts = mergeStableFacts(facts, { keyPaths: childPaths });
		for (const c of children) {
			if (/\.csproj$/i.test(c) || /Program\.cs$/i.test(c) || /package\.json$/i.test(c)) {
				facts = mergeStableFacts(facts, {
					stackHints: [stackHintFromName(c)],
					keyPaths: [base === '.' ? c : `${base}/${c}`],
				});
			}
		}
	}

	if (tool === 'read' && success && pathArg) {
		const hint = stackHintFromContent(output);
		if (hint) {
			facts = mergeStableFacts(facts, { stackHints: [hint] });
		}
	}

	if ((tool === 'write' || tool === 'edit') && success && pathArg) {
		facts = mergeStableFacts(facts, {
			keyPaths: [toRel(pathArg, root)],
			decisions: [`wrote ${toRel(pathArg, root)}`],
			openErrors: facts.openErrors.filter(e => !e.includes(toRel(pathArg!, root))),
		});
	}

	if (tool === 'shell' || tool === 'dotnet') {
		const cmd = tool === 'dotnet' ? `dotnet ${String(args.action ?? '').replace('_', ' ')}` : String(args.command ?? '');
		if (/dotnet/i.test(cmd)) {
			facts = mergeStableFacts(facts, { stackHints: ['.NET / dotnet CLI'] });
		}
		if (/npm|node/i.test(cmd)) {
			facts = mergeStableFacts(facts, { stackHints: ['Node / npm'] });
		}
		if (!success || /error CS|error RZ|Build FAILED|FAIL:/i.test(output)) {
			const errs = output
				.split(/\r?\n/)
				.filter(l => /error |FAIL|Exception|ENOENT|FILE_NOT_FOUND/i.test(l))
				.slice(0, 8)
				.map(l => l.trim().slice(0, 200));
			if (errs.length) {
				facts = mergeStableFacts(facts, { openErrors: errs });
			}
		} else if (
			/\b(dotnet\s+(build|test)|npm\s+(test|run\s+build)|pytest|cargo\s+(build|test)|go\s+test)\b/i.test(cmd) &&
			/Build succeeded|exit\s*[:=]?\s*0/i.test(output)
		) {
			facts = mergeStableFacts(facts, { openErrors: [], decisions: [`shell ok: ${cmd.slice(0, 80)}`] });
		}
	}

	if (tool === 'diagnostics' && output && output !== 'No diagnostics') {
		const errs = output
			.split(/\r?\n/)
			.filter(l => /\[Error\]/i.test(l))
			.slice(0, 15)
			.map(l => l.trim().slice(0, 220));
		facts = mergeStableFacts(facts, { openErrors: errs });
	}

	if (/FILE_NOT_FOUND|ENOENT|No such file/i.test(output)) {
		facts = mergeStableFacts(facts, {
			openErrors: [`missing: ${pathArg ?? output.slice(0, 120)}`],
		});
	}

	return facts;
}

export function formatStableFactsBlock(facts: StableFacts): string {
	const f = normalizeFacts(facts);
	if (
		!f.projectRoots.length &&
		!f.keyPaths.length &&
		!f.stackHints.length &&
		!f.decisions.length &&
		!f.openErrors.length
	) {
		return '';
	}
	return [
		'### STABLE FACTS (paths and state observed in this workspace)',
		f.projectRoots.length ? `- projectRoots: ${f.projectRoots.join(' | ')}` : '',
		f.keyPaths.length
			? `- keyPaths: ${f.keyPaths.slice(0, 40).join(', ')}${f.keyPaths.length > 40 ? ` …[+${f.keyPaths.length - 40}]` : ''}`
			: '',
		f.stackHints.length ? `- stackHints: ${f.stackHints.join('; ')}` : '',
		f.decisions.length ? `- decisions: ${f.decisions.slice(-10).join('; ')}` : '',
		f.openErrors.length
			? `- openErrors:\n${f.openErrors.slice(0, 12).map(e => `  · ${e}`).join('\n')}${f.openErrors.length > 12 ? `\n  …[+${f.openErrors.length - 12} errors]` : ''}`
			: '',
	]
		.filter(Boolean)
		.join('\n');
}

function firstPath(args: Record<string, unknown>): string | undefined {
	for (const key of ['path', 'oldPath', 'newPath']) {
		const v = args[key];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return undefined;
}

function toRel(p: string, root?: string): string {
	const norm = p.replace(/\\/g, '/');
	if (!root) return norm;
	const r = root.replace(/\\/g, '/');
	if (norm.toLowerCase().startsWith(r.toLowerCase() + '/')) {
		return norm.slice(r.length + 1);
	}
	if (eqPath(norm, r)) return '.';
	return norm;
}

function eqPath(a: string, b: string): boolean {
	return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

function detectProjectRoot(filePath: string, workspaceRoot?: string): string | undefined {
	const norm = filePath.replace(/\\/g, '/');
	const parts = norm.split('/');
	// e.g. Funcionarios/Pages/X.cshtml → Funcionarios (relative) or c:/Teste/Funcionarios/...
	if (workspaceRoot) {
		const rel = toRel(filePath, workspaceRoot);
		const top = rel.split('/')[0];
		if (top && top !== '.' && top !== '..' && !/\./.test(top)) {
			return `${workspaceRoot.replace(/\\/g, '/')}/${top}`.replace(/\//g, '\\');
		}
	}
	const idx = parts.findIndex(p => /\.(csproj|sln)$/i.test(p) || p === 'Program.cs');
	if (idx > 0) {
		return parts.slice(0, idx).join('\\');
	}
	return undefined;
}

function stackHintFromName(name: string): string {
	if (/\.csproj$/i.test(name)) return '.NET project (' + name + ')';
	if (/package\.json$/i.test(name)) return 'Node package.json';
	if (/Program\.cs$/i.test(name)) return '.NET entry Program.cs';
	return name;
}

function stackHintFromContent(content: string): string | undefined {
	if (/Microsoft\.AspNetCore\.Components/i.test(content)) return 'Blazor / ASP.NET Core Components';
	if (/Microsoft\.EntityFrameworkCore/i.test(content)) return 'EF Core';
	if (/<Project\s+Sdk=/i.test(content)) return '.NET SDK-style project';
	if (/"react"|from ['"]react['"]/i.test(content)) return 'React';
	return undefined;
}

function uniq(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of items) {
		const t = raw.trim();
		if (!t) continue;
		const key = t.replace(/\\/g, '/').toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
	}
	return out;
}
