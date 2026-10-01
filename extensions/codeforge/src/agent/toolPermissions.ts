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

export type ToolPermissionProfile = 'build' | 'explore' | 'plan' | 'status';

/** edit/write share the OpenCode `edit` permission key. */
const EDIT_TOOLS = new Set(['edit', 'write']);

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

function deny(...names: string[]): PermissionRuleset {
	return names.map(permission => ({ permission, pattern: '*', action: 'deny' as const }));
}

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
] as const;

/** Core coding surface for Agent (build) — lean vs full AGENT_TOOLS. */
const BUILD_ALLOWED_CORE = [
	'read',
	'write',
	'edit',
	'list',
	'search',
	'retrieve',
	'delete',
	'rename',
	'open',
	'shell',
	'dotnet',
	'diagnostics',
	'symbols',
	'references',
	'definition',
	'git_status',
	'git_diff',
	'git_log',
	'wiki_read',
	'wiki_search',
	'wiki_write',
	'update_status',
	'skill',
] as const;

export interface ProfileOptions {
	/** Include mcp_call when MCP tools are connected. */
	mcpAvailable?: boolean;
	/** Include delegate_task when exploreSubagent is enabled. */
	exploreSubagent?: boolean;
}

export function rulesetForProfile(
	profile: ToolPermissionProfile,
	opts: ProfileOptions = {}
): PermissionRuleset {
	switch (profile) {
		case 'status':
			return merge(denyAll(), allow('update_status'));
		case 'plan':
			return merge(denyAll(), allow(...PLAN_ALLOWED_TOOLS));
		case 'explore':
			return merge(denyAll(), allow(...EXPLORE_ALLOWED));
		case 'build': {
			const extras: string[] = [];
			if (opts.mcpAvailable) extras.push('mcp_call');
			if (opts.exploreSubagent) extras.push('delegate_task');
			return merge(denyAll(), allow(...BUILD_ALLOWED_CORE, ...extras));
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
