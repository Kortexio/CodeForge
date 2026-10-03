/**
 * Tool surface helpers + phase detection.
 * Tool names for the LLM request are filtered via OpenCode-style permissions
 * (denied tools are omitted from the schemas sent to the model).
 * Pure — no vscode.
 */

import {
	filterToolsByProfile,
	type ToolPermissionProfile,
	type ProfileOptions,
	PLAN_ALLOWED_TOOLS,
	ASK_ALLOWED_TOOLS,
} from './toolPermissions';

export { ASK_ALLOWED_TOOLS };

export type AgentPhase = 'explore' | 'implement' | 'fix' | 'review';

export { PLAN_ALLOWED_TOOLS };

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
	/\b(create|implement|add|fix|write|build|make|change|update|refactor|migrate|gerar|criar|cria|escrev\w*|implementar|implementa|corrigir|corrige|adicionar|adiciona|alterar|altera|refatorar|desenvolv\w*|executar|executa|continu[ae]r?|continue)\b/i;
const REVIEW_TASK =
	/\b(review|revis\w*|audit\w*|find (the )?bugs?|encontr\w* (os )?(bugs?|erros?)|procur\w* (bugs?|erros?)|analis\w*|analy[sz]\w*|code review|bugs?\.md)\b/i;

export function isCodingTask(task: string): boolean {
	return CODING_TASK.test(task);
}

export function isReviewTask(task: string): boolean {
	return REVIEW_TASK.test(task) && !/\b(fix|corrig\w*|implement\w*)\b/i.test(task);
}

/** Phase label for this turn (telemetry + tool profile). */
export function currentPhase(task: string, state: { buildRed: boolean }): AgentPhase {
	if (isReviewTask(task)) return 'review';
	if (state.buildRed) return 'fix';
	if (isCodingTask(task)) return 'implement';
	return 'explore';
}

export function profileForTurn(
	phase: AgentPhase,
	task: string,
	opts: { planMode?: boolean; coachMode?: boolean; askMode?: boolean }
): ToolPermissionProfile {
	void phase; // phase stays for telemetry / activity labels; tools follow mode below
	if (opts.coachMode) return 'coach';
	if (opts.askMode) return 'ask';
	if (isStatusQuestion(task)) return 'status';
	if (opts.planMode) return 'plan';
	// Agent mode: full tool surface (incl. shell for HTTPS/API). Do not strip shell/write
	// just because the prompt lacked coding verbs — that made "list /v1/models" explore-only.
	return 'build';
}

/**
 * Tool names exposed to the model this round.
 * Denied tools (OpenCode-style) are omitted from the request schemas.
 */
export function toolNamesFor(
	phase: AgentPhase,
	task: string,
	opts: {
		weakProfile: boolean;
		allNames: string[];
		planMode?: boolean;
		coachMode?: boolean;
		askMode?: boolean;
		mcpAvailable?: boolean;
		exploreSubagent?: boolean;
	}
): Set<string> {
	void opts.weakProfile;
	void opts.exploreSubagent;
	const profile = profileForTurn(phase, task, {
		planMode: opts.planMode,
		coachMode: opts.coachMode,
		askMode: opts.askMode,
	});
	const profileOpts: ProfileOptions = {
		mcpAvailable: opts.mcpAvailable === true,
	};
	return filterToolsByProfile(opts.allNames, profile, profileOpts);
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
			'.NET CLI: new | sln_add | add_reference | add_package | build | test.',
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
