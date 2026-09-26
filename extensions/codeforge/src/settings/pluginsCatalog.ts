/**
 * CodeForge Plugins marketplace catalog (Cursor-style Discover / Featured).
 * Installable entries wire to MCP presets or open the MCP editor.
 */

export type PluginKind = 'mcp' | 'skill';
export type PluginSection = 'discover' | 'featured' | 'productivity' | 'infrastructure' | 'skills';
export type PluginInstallAction =
	| 'atlassian'
	| 'azure'
	| 'github'
	| 'azure-devops'
	| 'mcp-preset'
	| 'none';

export interface PluginMcpPreset {
	id: string;
	name: string;
	transport?: 'stdio' | 'http';
	command?: string;
	args?: string[];
	url?: string;
	/** Hint shown after Add (env / token / org) */
	hint?: string;
}

export interface PluginCatalogItem {
	id: string;
	name: string;
	description: string;
	kind: PluginKind;
	section: PluginSection;
	/** Marketplace filter chip */
	marketplace: 'codeforge' | 'personal';
	publisher: string;
	/** Short label inside the icon tile */
	iconLabel: string;
	/** CSS color for the icon tile background */
	iconColor: string;
	installAction: PluginInstallAction;
	/** Detect installed MCP by id / name / args / url substring */
	matchMcp?: {
		ids?: string[];
		nameRe?: string;
		argsRe?: string;
		urlRe?: string;
	};
	/** stdio/http preset when installAction === 'mcp-preset' */
	mcpPreset?: PluginMcpPreset;
	/** Show in Discover carousel */
	discover?: boolean;
	/** Show in Featured grid */
	featured?: boolean;
}

export const PLUGIN_CATALOG: PluginCatalogItem[] = [
	{
		id: 'atlassian',
		name: 'Atlassian',
		description: 'Jira, Confluence, and Loom via Rovo MCP (OAuth).',
		kind: 'mcp',
		section: 'productivity',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'At',
		iconColor: '#0052CC',
		installAction: 'atlassian',
		matchMcp: {
			ids: ['atlassian-rovo'],
			nameRe: '^atlassian$',
			argsRe: 'mcp\\.atlassian\\.com',
		},
		discover: true,
		featured: true,
	},
	{
		id: 'azure',
		name: 'Azure',
		description: 'Query Azure resources with the official Azure MCP (@azure/mcp).',
		kind: 'mcp',
		section: 'infrastructure',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Az',
		iconColor: '#0078D4',
		installAction: 'azure',
		matchMcp: {
			ids: ['azure-mcp'],
			nameRe: '^azure(\\s+mcp(\\s+server)?)?$',
			argsRe: '@azure\\/mcp',
		},
		discover: true,
		featured: true,
	},
	{
		id: 'github',
		name: 'GitHub',
		description: 'Issues, PRs, and code via the official GitHub MCP (remote; PAT in API key).',
		kind: 'mcp',
		section: 'productivity',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'GH',
		iconColor: '#24292F',
		installAction: 'github',
		matchMcp: {
			ids: ['github-mcp'],
			nameRe: '^github$',
			argsRe: 'github-mcp-server|@modelcontextprotocol\\/server-github',
			urlRe: 'api\\.githubcopilot\\.com\\/mcp',
		},
		discover: true,
		featured: true,
	},
	{
		id: 'azure-devops',
		name: 'Azure DevOps',
		description: 'Work items, repos, pipelines, and wiki via @azure-devops/mcp (local stdio).',
		kind: 'mcp',
		section: 'productivity',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'ADO',
		iconColor: '#0078D4',
		installAction: 'azure-devops',
		matchMcp: {
			ids: ['azure-devops-mcp'],
			nameRe: 'azure\\s*devops|^ado$',
			argsRe: '@azure-devops\\/mcp|mcp\\.dev\\.azure\\.com',
			urlRe: 'mcp\\.dev\\.azure\\.com',
		},
		discover: true,
		featured: true,
	},
	{
		id: 'filesystem',
		name: 'Filesystem',
		description: 'Scoped filesystem tools via the official MCP filesystem server.',
		kind: 'mcp',
		section: 'infrastructure',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'FS',
		iconColor: '#6B7280',
		installAction: 'mcp-preset',
		matchMcp: {
			ids: ['filesystem-mcp'],
			nameRe: 'filesystem|file\\s*system',
			argsRe: 'server-filesystem',
		},
		mcpPreset: {
			id: 'filesystem-mcp',
			name: 'Filesystem',
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
			hint: 'Edit Args to restrict roots, then Refresh MCP.',
		},
		featured: true,
	},
	{
		id: 'playwright',
		name: 'Playwright',
		description: 'Browser automation tools for the agent (navigate, click, snapshot).',
		kind: 'mcp',
		section: 'infrastructure',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Pw',
		iconColor: '#2EAD33',
		installAction: 'mcp-preset',
		matchMcp: {
			ids: ['playwright-mcp'],
			nameRe: 'playwright',
			argsRe: 'playwright',
		},
		mcpPreset: {
			id: 'playwright-mcp',
			name: 'Playwright',
			command: 'npx',
			args: ['-y', '@playwright/mcp@latest'],
			hint: 'Refresh MCP after install. First run may download browsers.',
		},
		featured: true,
	},
	{
		id: 'postgres',
		name: 'PostgreSQL',
		description: 'Read-only SQL tools against a Postgres connection string.',
		kind: 'mcp',
		section: 'infrastructure',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'PG',
		iconColor: '#336791',
		installAction: 'mcp-preset',
		matchMcp: {
			ids: ['postgres-mcp'],
			nameRe: 'postgres|postgresql',
			argsRe: 'server-postgres',
		},
		mcpPreset: {
			id: 'postgres-mcp',
			name: 'PostgreSQL',
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'],
			hint: 'Replace the connection string in Args, then Refresh MCP.',
		},
	},
	{
		id: 'slack',
		name: 'Slack',
		description: 'Search channels and messages when Slack MCP is configured.',
		kind: 'mcp',
		section: 'productivity',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Sl',
		iconColor: '#4A154B',
		installAction: 'mcp-preset',
		matchMcp: {
			ids: ['slack-mcp'],
			nameRe: 'slack',
			argsRe: 'server-slack|slack',
		},
		mcpPreset: {
			id: 'slack-mcp',
			name: 'Slack',
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-slack'],
			hint: 'Set SLACK_BOT_TOKEN / SLACK_TEAM_ID in Environment variables.',
		},
	},
	{
		id: 'skill-atlassian',
		name: 'Atlassian skill',
		description: 'Guidance for calling Atlassian MCP tools from the agent (ships built-in).',
		kind: 'skill',
		section: 'skills',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Sk',
		iconColor: '#0D9488',
		installAction: 'none',
	},
	{
		id: 'skill-azure',
		name: 'Azure skill',
		description: 'Guidance for Azure MCP auth and tool usage (ships built-in).',
		kind: 'skill',
		section: 'skills',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Sk',
		iconColor: '#0D9488',
		installAction: 'none',
	},
	{
		id: 'skill-github',
		name: 'GitHub skill',
		description: 'Guidance for GitHub MCP (issues, PRs, repos) — ships built-in.',
		kind: 'skill',
		section: 'skills',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Sk',
		iconColor: '#0D9488',
		installAction: 'none',
	},
	{
		id: 'skill-azure-devops',
		name: 'Azure DevOps skill',
		description: 'Guidance for Azure DevOps MCP (work items, pipelines) — ships built-in.',
		kind: 'skill',
		section: 'skills',
		marketplace: 'codeforge',
		publisher: 'CodeForge',
		iconLabel: 'Sk',
		iconColor: '#0D9488',
		installAction: 'none',
	},
];

export interface McpLike {
	id: string;
	name: string;
	args?: string[];
	url?: string;
}

export function isPluginInstalled(plugin: PluginCatalogItem, mcpServers: McpLike[]): boolean {
	if (plugin.kind !== 'mcp' || !plugin.matchMcp) return false;
	const { ids, nameRe, argsRe, urlRe } = plugin.matchMcp;
	const nameRx = nameRe ? new RegExp(nameRe, 'i') : null;
	const argsRx = argsRe ? new RegExp(argsRe, 'i') : null;
	const urlRx = urlRe ? new RegExp(urlRe, 'i') : null;
	return mcpServers.some(s => {
		if (ids?.includes(s.id)) return true;
		if (nameRx && nameRx.test(s.name.trim())) return true;
		if (argsRx && (s.args ?? []).some(a => argsRx.test(a))) return true;
		if (urlRx && s.url && urlRx.test(s.url)) return true;
		return false;
	});
}
