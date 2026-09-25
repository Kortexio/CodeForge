/**
 * Tool surface per phase. Fewer, clearer tools per turn instead of advice text.
 * Pure — no vscode.
 */

export type AgentPhase = 'explore' | 'implement' | 'fix' | 'review';

/** Standing status is written every turn, including questions that do not match a phase. */
const ALWAYS_TOOLS = ['update_status'];

const READONLY = [
	'read',
	'retrieve',
	'list',
	'search',
	'symbols',
	'definition',
	'references',
	'diagnostics',
];

const PHASE_TOOLS: Record<AgentPhase, string[]> = {
	explore: ['read', 'retrieve', 'list', 'search', 'symbols', 'definition', 'references'],
	implement: ['edit', 'write', 'dotnet', 'shell', 'read', 'retrieve', 'list', 'search', 'symbols', 'diagnostics', 'delete', 'rename'],
	fix: ['read', 'edit', 'write', 'dotnet', 'shell', 'diagnostics', 'search', 'symbols', 'definition', 'references'],
	// Review may write its report (BUGS.md); everything else is readonly.
	review: [...READONLY, 'write'],
};

const EXTRA_GROUPS: Array<{ tools: string[]; when: RegExp }> = [
	{ tools: ['git_status', 'git_diff', 'git_log', 'git_commit_msg', 'git_blame', 'git_conflicts'], when: /\bgit\b|commit|diff\b|branch|blame|merge|conflit|conflict/i },
	{ tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot'], when: /browser|navegador|https?:\/\/|localhost:\d+|screenshot|p[áa]gina web|web page|\bui\b visual/i },
	{ tools: ['wiki_read', 'wiki_write', 'wiki_search', 'wiki_fact', 'wiki_facts'], when: /\bwiki\b|mem[óo]ria|memory|\bfacts?\b|task-plan/i },
	{ tools: ['delegate_task'], when: /delegat|subagent|sub-agente|paralel/i },
	{ tools: ['mcp_call'], when: /\bmcp\b/i },
	{ tools: ['open'], when: /\babr[ea]\b|\bopen\b.*\beditor\b/i },
];

/** A question about where the work stopped. Not a request to continue or change code. */
export function isStatusQuestion(task: string): boolean {
	if (/\b(continu[ae]|continue|implement\w*|fix|corrig\w*|cria\w*|create|build|add|adicion\w*)\b/i.test(task)) {
		return false;
	}
	return /\b(onde\s+(paramos|ficamos|estavamos|estávamos)|em\s+que\s+ponto|o\s+andamento|where\s+did\s+we\s+(stop|leave)|where\s+we\s+left)\b/i.test(
		task
	);
}

const CODING_TASK =
	/\b(create|implement|add|fix|write|build|make|change|update|refactor|migrate|gerar|criar|cria|implementar|implementa|corrigir|corrige|adicionar|adiciona|alterar|altera|refatorar|desenvolv\w*|executar|executa)\b/i;
const REVIEW_TASK =
	/\b(review|revis\w*|audit\w*|find (the )?bugs?|encontr\w* (os )?(bugs?|erros?)|procur\w* (bugs?|erros?)|analis\w*|analy[sz]\w*|code review|bugs?\.md)\b/i;

export function isCodingTask(task: string): boolean {
	return CODING_TASK.test(task);
}

export function isReviewTask(task: string): boolean {
	return REVIEW_TASK.test(task) && !/\b(fix|corrig\w*|implement\w*)\b/i.test(task);
}

/** Phase for this turn (weak profile only; strong models keep the full surface). */
export function currentPhase(task: string, state: { buildRed: boolean }): AgentPhase {
	if (isReviewTask(task)) return 'review';
	if (state.buildRed) return 'fix';
	if (isCodingTask(task)) return 'implement';
	return 'explore';
}

/** Tool names for this turn. Extra groups only when the task asks for them. */
export function toolNamesFor(
	phase: AgentPhase,
	task: string,
	opts: { weakProfile: boolean; allNames: string[]; planMode?: boolean }
): Set<string> {
	if (isStatusQuestion(task)) {
		return new Set(opts.allNames.filter(n => n === 'update_status'));
	}
	if (!opts.weakProfile) return new Set(opts.allNames);
	const names = new Set([...PHASE_TOOLS[phase], ...ALWAYS_TOOLS]);
	for (const g of EXTRA_GROUPS) {
		if (g.when.test(task)) g.tools.forEach(t => names.add(t));
	}
	return new Set(opts.allNames.filter(n => names.has(n)));
}

/** Existing files above this size are changed with edit, not rewritten (weak profile). */
export const LARGE_FILE_LINES = 60;

/**
 * A write that keeps most of the old lines is a partial change disguised as a rewrite
 * (the risky kind: silently dropped code). A genuine rewrite shares few lines.
 */
export function isPartialRewrite(oldText: string, newText: string): boolean {
	const norm = (s: string) =>
		s
			.split(/\r?\n/)
			.map(l => l.trim())
			.filter(l => l.length > 2);
	const oldLines = norm(oldText);
	if (!oldLines.length) return false;
	const newSet = new Set(norm(newText));
	const kept = oldLines.filter(l => newSet.has(l)).length;
	return kept / oldLines.length >= 0.5;
}

/** A read of a file named in the current build errors is part of fixing, not exploring. */
export function mentionsErrorFile(pathArg: string, errors: string[]): boolean {
	const p = pathArg.replace(/\\/g, '/').toLowerCase();
	if (!p) return false;
	const base = p.split('/').pop() ?? p;
	return errors.some(e => {
		const el = e.replace(/\\/g, '/').toLowerCase();
		return el.includes(p) || el.includes(base);
	});
}

export const DOTNET_ACTIONS = ['new', 'sln_add', 'add_reference', 'add_package', 'build', 'test'] as const;
export type DotnetAction = (typeof DOTNET_ACTIONS)[number];

function q(v: unknown): string {
	const s = String(v ?? '').trim();
	return /\s/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s;
}

/**
 * Structured dotnet call → one command line. Returns an error string for invalid input
 * so the model gets a precise message instead of a failing shell.
 */
export function buildDotnetCommand(args: Record<string, unknown>): { command: string } | { error: string } {
	const action = String(args.action ?? '') as DotnetAction;
	const project = args.project ? q(args.project) : '';
	switch (action) {
		case 'new': {
			const template = String(args.template ?? '').trim();
			if (!template) return { error: 'dotnet new needs template (e.g. classlib, xunit, console, webapi, sln).' };
			const parts = ['dotnet new', template];
			if (args.name) parts.push('-n', q(args.name));
			if (args.output) parts.push('-o', q(args.output));
			if (args.framework) parts.push('-f', q(args.framework));
			return { command: parts.join(' ') };
		}
		case 'sln_add': {
			if (!args.solution || !project) return { error: 'sln_add needs solution and project paths.' };
			return { command: `dotnet sln ${q(args.solution)} add ${project}` };
		}
		case 'add_reference': {
			if (!project || !args.reference) return { error: 'add_reference needs project and reference (.csproj paths).' };
			return { command: `dotnet add ${project} reference ${q(args.reference)}` };
		}
		case 'add_package': {
			if (!project || !args.package) return { error: 'add_package needs project and package.' };
			const version = args.version ? ` --version ${q(args.version)}` : '';
			return { command: `dotnet add ${project} package ${q(args.package)}${version}` };
		}
		case 'build':
			return { command: `dotnet build${project ? ` ${project}` : ''} -nologo -v q` };
		case 'test': {
			const filter = args.filter ? ` --filter ${q(args.filter)}` : '';
			return { command: `dotnet test${project ? ` ${project}` : ''} -nologo -v q${filter}` };
		}
		default:
			return { error: `Unknown dotnet action "${action}". Use one of: ${DOTNET_ACTIONS.join(', ')}.` };
	}
}

export const DOTNET_TOOL = {
	type: 'function' as const,
	function: {
		name: 'dotnet',
		description:
			'Run a .NET CLI action from the workspace root. Actions: new (template, name, output), sln_add (solution, project), add_reference (project, reference), add_package (project, package, version?), build (project?), test (project?, filter?). Paths are relative to the workspace root.',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: [...DOTNET_ACTIONS] },
				project: { type: 'string', description: '.csproj / .sln / .slnx path' },
				template: { type: 'string' },
				name: { type: 'string' },
				output: { type: 'string' },
				framework: { type: 'string' },
				solution: { type: 'string' },
				reference: { type: 'string' },
				package: { type: 'string' },
				version: { type: 'string' },
				filter: { type: 'string' },
			},
			required: ['action'],
		},
	},
};
