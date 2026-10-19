/**
 * OpenCode-style tool permissions: allow / ask / deny.
 * Tools with wildcard deny are removed from the LLM request (not only blocked at execute).
 * Pure — no vscode.
 */

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
	permission: string;
	pattern: string;
	action: PermissionAction;
}

export type PermissionRuleset = PermissionRule[];

export type ToolPermissionProfile = 'build' | 'explore' | 'plan' | 'status' | 'coach' | 'ask' | 'review';

/** edit/write/apply_patch share the OpenCode `edit` permission key. */
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch']);

function permissionKeyForTool(tool: string): string {
	return EDIT_TOOLS.has(tool) ? 'edit' : tool;
}

function wildcardMatch(value: string, pattern: string): boolean {
	if (pattern === '*') return true;
	if (pattern === value) return true;
	// Simple prefix* suffix (e.g. browser_*)
	if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) {
		return value.startsWith(pattern.slice(0, -1));
	}
	return false;
}

export function merge(...rulesets: PermissionRuleset[]): PermissionRuleset {
	return rulesets.flat();
}

/**
 * Tools that must not appear in the LLM `tools` array.
 * Mirrors OpenCode Permission.disabled: only pattern "*" + deny removes a tool.
 * Prefix patterns like browser_* are applied by expanding into per-tool deny rules in profiles.
 */
export function disabled(toolNames: string[], ruleset: PermissionRuleset): Set<string> {
	const result = new Set<string>();
	for (const tool of toolNames) {
		const key = permissionKeyForTool(tool);
		const rule = [...ruleset].reverse().find(r => wildcardMatch(key, r.permission));
		if (!rule) continue;
		if (rule.pattern === '*' && rule.action === 'deny') {
			result.add(tool);
		}
	}
	return result;
}

function denyAll(): PermissionRuleset {
	return [{ permission: '*', pattern: '*', action: 'deny' }];
}

function allow(...names: string[]): PermissionRuleset {
	return names.map(permission => ({ permission, pattern: '*', action: 'allow' as const }));
}

/** Ask mode: read the repo + web (no writes / shell mutators). */
export const ASK_ALLOWED_TOOLS = [
	'list',
	'read',
	'search',
	'retrieve',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'git_status',
	'git_diff',
	'git_log',
	'git_blame',
	'open',
	'wiki_read',
	'wiki_search',
	'wiki_facts',
	'web_search',
	'web_fetch',
	'skill',
	'update_status',
	'todo_write',
] as const;

/**
 * Bug-hunt sub-runs: read/search plus shell/dotnet to execute boundary checks.
 * No write/edit — the pipeline writes BUGS.md itself.
 */
export const REVIEW_ALLOWED_TOOLS = [
	...ASK_ALLOWED_TOOLS,
	'shell',
	'await_shell',
	'dotnet',
] as const;

/** Plan-mode allow-list (same surface as legacy PLAN_MODE_TOOLS). */
export const PLAN_ALLOWED_TOOLS = [
	'list',
	'read',
	'search',
	'retrieve',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'git_status',
	'git_diff',
	'git_log',
	'git_blame',
	'open',
	'wiki_read',
	'wiki_search',
	'wiki_write',
	'wiki_fact',
	'wiki_facts',
	'update_status',
	'skill',
	'web_search',
	'web_fetch',
	'todo_write',
	/** Draft/lock checks for the experiment loop (path-gated at execute). */
	'write',
	'edit',
	'apply_patch',
] as const;

/** Method coach: read + skill + write/edit gated to how-to-work only. */
export const COACH_ALLOWED_TOOLS = [
	'list',
	'read',
	'search',
	'retrieve',
	'skill',
	'write',
	'edit',
	'apply_patch',
	'update_status',
	'todo_write',
] as const;

const EXPLORE_ALLOWED = [
	'read',
	'list',
	'search',
	'retrieve',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'open',
	'skill',
	'update_status',
	'git_status',
	'git_diff',
	'git_log',
	'web_search',
	'web_fetch',
] as const;

/**
 * Default Agent surface: CORE only. Optional groups come from
 * `codeforge.ai.toolGroups` and `AgentModeDefinition.toolGroups`.
 */
export const CORE = [
	'read',
	'edit',
	'write',
	'apply_patch',
	'list',
	'search',
	'retrieve',
	'shell',
	'await_shell',
	'dotnet',
	'diagnostics',
	'todo_write',
	'delegate_task',
	'update_status',
	'skill',
] as const;

export const TOOL_GROUPS = {
	git: [
		'git_status',
		'git_diff',
		'git_log',
		'git_blame',
		'git_conflicts',
		'git_commit_msg',
		'git_add',
		'git_commit',
		'git_push',
		'gh_pr_create',
	],
	wiki: ['wiki_read', 'wiki_search', 'wiki_write', 'wiki_fact', 'wiki_facts'],
	browser: [
		'browser_navigate',
		'browser_snapshot',
		'browser_click',
		'browser_type',
		'browser_screenshot',
	],
	web: ['web_search', 'web_fetch'],
	media: ['generate_image', 'canvas_write', 'voice_status'],
	notebook: ['edit_notebook'],
	navigation: ['symbols', 'references', 'definition'],
	files: ['delete', 'rename', 'open'],
} as const;

export type ToolGroupName = keyof typeof TOOL_GROUPS;

export function toolsForGroups(groups: Iterable<string>): string[] {
	const out: string[] = [];
	for (const g of groups) {
		const key = String(g).trim() as ToolGroupName;
		const list = TOOL_GROUPS[key];
		if (list) out.push(...list);
	}
	return out;
}

export interface ProfileOptions {
	/** Include mcp_call when MCP tools are connected. */
	mcpAvailable?: boolean;
	/** @deprecated delegate_task is always in build; kept for callers. */
	exploreSubagent?: boolean;
	/**
	 * Enabled optional tool groups for the build profile
	 * (from config + agent mode). Ignored for other profiles.
	 */
	toolGroups?: string[];
}

export function rulesetForProfile(
	profile: ToolPermissionProfile,
	opts: ProfileOptions = {}
): PermissionRuleset {
	switch (profile) {
		case 'status':
			return merge(denyAll(), allow('update_status'));
		case 'ask':
			return merge(denyAll(), allow(...ASK_ALLOWED_TOOLS));
		case 'review':
			return merge(denyAll(), allow(...REVIEW_ALLOWED_TOOLS));
		case 'plan':
			return merge(denyAll(), allow(...PLAN_ALLOWED_TOOLS));
		case 'coach':
			return merge(denyAll(), allow(...COACH_ALLOWED_TOOLS));
		case 'explore':
			return merge(denyAll(), allow(...EXPLORE_ALLOWED));
		case 'build': {
			const extras: string[] = [...toolsForGroups(opts.toolGroups ?? [])];
			if (opts.mcpAvailable) extras.push('mcp_call');
			return merge(denyAll(), allow(...CORE, ...extras));
		}
	}
}

export function filterToolsByRuleset(allNames: string[], ruleset: PermissionRuleset): Set<string> {
	const off = disabled(allNames, ruleset);
	return new Set(allNames.filter(n => !off.has(n)));
}

export function filterToolsByProfile(
	allNames: string[],
	profile: ToolPermissionProfile,
	opts: ProfileOptions = {}
): Set<string> {
	return filterToolsByRuleset(allNames, rulesetForProfile(profile, opts));
}
