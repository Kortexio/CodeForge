/**
 * CodeForge AI — server / model / MCP configuration store
 *
 * Settings UI owns the full catalog.
 * QuickPick only switches the active model while working.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { aiSettingsFile, ensureDir, homeRoot } from '../storage/paths';
import { readSettingsFromProfileDbs } from './settingsProfileImport';

export type ServerKind =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'xai'
	| 'openrouter'
	| 'ollama'
	| 'vllm'
	| 'lmstudio'
	| 'custom';

export interface AiServer {
	id: string;
	name: string;
	kind: ServerKind;
	baseUrl: string;
	apiKey?: string;
	/** Models available on this server (user-managed list). */
	models: string[];
	/**
	 * Context window for this server/model (tokens).
	 * Sent as options.num_ctx when supported; also drives client compact/caps.
	 */
	numCtx?: number;
	/**
	 * When true, requests send response_format=json_object (OpenAI-compat).
	 * Useful for local servers that dump tool_calls into content as JSON.
	 */
	forceJson?: boolean;
	/** Optional embedding model id for semantic retrieve. */
	embeddingModel?: string;
	enabled: boolean;
}

export interface McpServerConfig {
	id: string;
	name: string;
	transport?: 'stdio' | 'http';
	command?: string;
	args?: string[];
	url?: string;
	apiKey?: string;
	env?: Record<string, string>;
	enabled: boolean;
}

export interface AiSettingsState {
	servers: AiServer[];
	/** Active server id */
	activeServerId: string | null;
	/** Active model id/name on that server */
	activeModel: string | null;
	mcpServers: McpServerConfig[];
}

const STATE_KEY = 'codeforge.ai.settings.v1';
const LEGACY_STATE_KEY = 'opencodeide.ai.settings.v1';

const DEFAULT_MODELS: Record<ServerKind, string[]> = {
	openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
	anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest'],
	google: ['gemini-2.0-flash', 'gemini-1.5-pro'],
	xai: ['grok-2', 'grok-2-mini'],
	openrouter: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
	ollama: ['llama3.2', 'qwen2.5-coder', 'deepseek-coder-v2'],
	vllm: ['default'],
	lmstudio: ['local-model'],
	custom: ['default'],
};

const DEFAULT_BASE_URL: Partial<Record<ServerKind, string>> = {
	openai: 'https://api.openai.com/v1',
	// Prefer OpenAI-compatible Anthropic endpoint when available; native API handled in agent loop
	anthropic: 'https://api.anthropic.com/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta',
	xai: 'https://api.x.ai/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	ollama: 'http://localhost:11434/v1',
	vllm: 'http://localhost:8000/v1',
	lmstudio: 'http://localhost:1234/v1',
	custom: '',
};

function emptyState(): AiSettingsState {
	return {
		servers: [],
		activeServerId: null,
		activeModel: null,
		mcpServers: [],
	};
}

/** Cloud providers without an API key are not usable for chat. */
function isUsableServer(server: AiServer): boolean {
	const local = server.kind === 'ollama' || server.kind === 'lmstudio' || server.kind === 'vllm';
	if (local) {
		return Boolean(server.baseUrl?.trim()) && server.enabled !== false;
	}
	if (server.kind === 'custom') {
		return Boolean(server.baseUrl?.trim());
	}
	return Boolean(server.apiKey?.trim());
}

/** Old first-run seed filled DEFAULT_MODELS without a key — not a user draft. */
function looksLikeLegacyAutoSeed(server: AiServer): boolean {
	if (server.apiKey?.trim()) return false;
	const local = server.kind === 'ollama' || server.kind === 'lmstudio' || server.kind === 'vllm';
	if (local || server.kind === 'custom') return false;
	const defaults = DEFAULT_MODELS[server.kind] ?? [];
	if (!defaults.length || !server.models?.length) return false;
	return defaults.every(m => server.models.includes(m));
}

export class AiSettingsStore {
	private readonly _onDidChange = new vscode.EventEmitter<AiSettingsState>();
	readonly onDidChange = this._onDidChange.event;
	private purgedPlaceholders = false;
	private unifiedOnce = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	getState(): AiSettingsState {
		const disk = this.readDiskSync();
		const raw =
			this.context.globalState.get<AiSettingsState>(STATE_KEY) ??
			this.context.globalState.get<AiSettingsState>(LEGACY_STATE_KEY);
		let state: AiSettingsState;
		if (disk && Array.isArray(disk.servers)) {
			// Shared disk file is the source of truth across profiles.
			state = disk;
		} else if (raw && Array.isArray(raw.servers)) {
			state = raw;
		} else {
			return this.seedFromLegacySettings();
		}
		const cfgBudget =
			vscode.workspace.getConfiguration('codeforge.ai').get<number>('contextBudget') ?? 32768;
		state = {
			servers: (state.servers ?? []).map(s => ({
				...s,
				numCtx: typeof s.numCtx === 'number' && s.numCtx > 0 ? s.numCtx : cfgBudget,
				forceJson: s.forceJson === true,
			})),
			activeServerId: state.activeServerId ?? null,
			activeModel: state.activeModel ?? null,
			mcpServers: state.mcpServers ?? [],
		};
		state = this.dropUnconfiguredPlaceholders(state);
		return state;
	}

	/**
	 * One-shot: merge install (CodeForge) + vscode:dev profiles into ~/.CodeForge/ai/settings.json
	 * so both share the same server catalog. Never deletes user servers.
	 */
	async unifyProfiles(log?: (line: string) => void): Promise<AiSettingsState> {
		if (this.unifiedOnce) {
			return this.getState();
		}
		this.unifiedOnce = true;

		const current = this.getState();
		const fromProfiles = await readSettingsFromProfileDbs(log);
		let merged = current;
		for (const other of fromProfiles) {
			merged = mergeSettingsStates(merged, other);
		}
		const disk = this.readDiskSync();
		if (disk) {
			merged = mergeSettingsStates(merged, disk);
		}

		await this.save(merged);
		log?.(
			`AI settings unified: ${merged.servers.length} server(s), active=${merged.activeModel ?? '(none)'} → ${aiSettingsFile()}`
		);
		return merged;
	}

	async save(state: AiSettingsState): Promise<void> {
		await this.context.globalState.update(STATE_KEY, state);
		await this.writeDisk(state);
		await this.syncActiveToWorkspaceSettings(state);
		this._onDidChange.fire(state);
	}

	private readDiskSync(): AiSettingsState | undefined {
		try {
			// sync read — getState is sync today
			const { readFileSync } = require('fs') as typeof import('fs');
			const raw = readFileSync(aiSettingsFile(), 'utf8');
			const parsed = JSON.parse(raw) as AiSettingsState;
			if (parsed && Array.isArray(parsed.servers)) {
				return parsed;
			}
		} catch {
			/* missing */
		}
		return undefined;
	}

	private async writeDisk(state: AiSettingsState): Promise<void> {
		try {
			await ensureDir(path.join(homeRoot(), 'ai'));
			await fs.writeFile(aiSettingsFile(), JSON.stringify(state, null, 2), 'utf8');
		} catch (err) {
			console.warn(
				'[codeforge] failed to write shared AI settings:',
				err instanceof Error ? err.message : err
			);
		}
	}

	getActiveServer(): AiServer | undefined {
		const state = this.getState();
		return state.servers.find(s => s.id === state.activeServerId && s.enabled && isUsableServer(s));
	}

	getActiveSelection(): { server?: AiServer; model?: string } {
		const state = this.getState();
		const server = state.servers.find(
			s => s.id === state.activeServerId && s.enabled && isUsableServer(s)
		);
		if (!server) {
			return {};
		}
		const model =
			state.activeModel && server.models.includes(state.activeModel)
				? state.activeModel
				: server.models[0];
		return { server, model };
	}

	async setActiveModel(serverId: string, model: string): Promise<void> {
		const state = this.getState();
		state.activeServerId = serverId;
		state.activeModel = model;
		await this.save(state);
	}

	createServerDraft(kind: ServerKind = 'openai'): AiServer {
		const cfgBudget =
			vscode.workspace.getConfiguration('codeforge.ai').get<number>('contextBudget') ?? 32768;
		return {
			id: randomUUID(),
			name: kindLabel(kind),
			kind,
			baseUrl: DEFAULT_BASE_URL[kind] ?? '',
			apiKey: '',
			// Start empty — user fetches models or types ids after adding a real server.
			models: [],
			numCtx: cfgBudget,
			forceJson: false,
			enabled: true,
		};
	}

	createMcpDraft(): McpServerConfig {
		return {
			id: randomUUID(),
			name: 'MCP Server',
			transport: 'stdio',
			command: '',
			args: [],
			url: '',
			apiKey: '',
			env: undefined,
			enabled: true,
		};
	}

	/**
	 * Official Atlassian Rovo MCP (Jira / Confluence / …) via mcp-remote OAuth proxy.
	 * Same remote as Cursor’s Atlassian plugin: https://mcp.atlassian.com/v2/mcp
	 */
	createAtlassianMcpPreset(): McpServerConfig {
		return {
			id: 'atlassian-rovo',
			name: 'Atlassian',
			transport: 'stdio',
			command: 'npx',
			args: ['-y', 'mcp-remote@latest', 'https://mcp.atlassian.com/v2/mcp'],
			url: '',
			apiKey: '',
			env: undefined,
			enabled: true,
		};
	}

	/** Add Atlassian preset if missing; returns the config (existing or new). */
	async ensureAtlassianMcp(): Promise<{ added: boolean; server: McpServerConfig }> {
		const state = this.getState();
		const existing = state.mcpServers.find(
			s =>
				s.id === 'atlassian-rovo' ||
				/^atlassian$/i.test(s.name.trim()) ||
				(s.args ?? []).some(a => /mcp\.atlassian\.com/i.test(a))
		);
		if (existing) {
			return { added: false, server: existing };
		}
		const server = this.createAtlassianMcpPreset();
		state.mcpServers.push(server);
		await this.save(state);
		return { added: true, server };
	}

	/**
	 * Official Azure MCP Server (`@azure/mcp`) — same args as Cursor / VS Code docs.
	 * Auth uses local Azure credentials (`az login` / Entra ID).
	 */
	createAzureMcpPreset(): McpServerConfig {
		return {
			id: 'azure-mcp',
			name: 'Azure',
			transport: 'stdio',
			command: 'npx',
			args: ['-y', '@azure/mcp@latest', 'server', 'start'],
			url: '',
			apiKey: '',
			env: undefined,
			enabled: true,
		};
	}

	/** Add Azure preset if missing; returns the config (existing or new). */
	async ensureAzureMcp(): Promise<{ added: boolean; server: McpServerConfig }> {
		const state = this.getState();
		const existing = state.mcpServers.find(
			s =>
				s.id === 'azure-mcp' ||
				/^azure(\s+mcp(\s+server)?)?$/i.test(s.name.trim()) ||
				(s.args ?? []).some(a => /@azure\/mcp/i.test(a))
		);
		if (existing) {
			return { added: false, server: existing };
		}
		const server = this.createAzureMcpPreset();
		state.mcpServers.push(server);
		await this.save(state);
		return { added: true, server };
	}

	/**
	 * Official GitHub remote MCP (hosted): https://api.githubcopilot.com/mcp/
	 * Auth: paste a GitHub PAT into the MCP server API key field.
	 */
	createGithubMcpPreset(): McpServerConfig {
		return {
			id: 'github-mcp',
			name: 'GitHub',
			transport: 'http',
			command: '',
			args: [],
			url: 'https://api.githubcopilot.com/mcp/',
			apiKey: '',
			env: undefined,
			enabled: true,
		};
	}

	async ensureGithubMcp(): Promise<{ added: boolean; server: McpServerConfig }> {
		const state = this.getState();
		const existing = state.mcpServers.find(
			s =>
				s.id === 'github-mcp' ||
				/^github$/i.test(s.name.trim()) ||
				/api\.githubcopilot\.com\/mcp/i.test(s.url ?? '') ||
				(s.args ?? []).some(a => /github-mcp-server|@modelcontextprotocol\/server-github/i.test(a))
		);
		if (existing) {
			return { added: false, server: existing };
		}
		const server = this.createGithubMcpPreset();
		state.mcpServers.push(server);
		await this.save(state);
		return { added: true, server };
	}

	/**
	 * Local Azure DevOps MCP (`@azure-devops/mcp`) — recommended for clients
	 * without Microsoft Entra OAuth (same guidance as Cursor / Claude).
	 */
	createAzureDevOpsMcpPreset(organization: string): McpServerConfig {
		const org = organization
			.trim()
			.replace(/^https?:\/\/dev\.azure\.com\//i, '')
			.replace(/\/$/, '');
		return {
			id: 'azure-devops-mcp',
			name: 'Azure DevOps',
			transport: 'stdio',
			command: 'npx',
			args: ['-y', '@azure-devops/mcp', org],
			url: '',
			apiKey: '',
			env: undefined,
			enabled: true,
		};
	}

	async ensureAzureDevOpsMcp(
		organization?: string
	): Promise<{ added: boolean; server: McpServerConfig; cancelled?: boolean }> {
		const state = this.getState();
		const existing = state.mcpServers.find(
			s =>
				s.id === 'azure-devops-mcp' ||
				/azure\s*devops|^ado$/i.test(s.name.trim()) ||
				(s.args ?? []).some(a => /@azure-devops\/mcp|mcp\.dev\.azure\.com/i.test(a)) ||
				/mcp\.dev\.azure\.com/i.test(s.url ?? '')
		);
		if (existing) {
			return { added: false, server: existing };
		}
		let org = (organization ?? '').trim();
		if (!org) {
			org =
				(
					await vscode.window.showInputBox({
						title: 'Azure DevOps organization',
						prompt: 'Organization name only (e.g. contoso), not the full URL',
						placeHolder: 'contoso',
						ignoreFocusOut: true,
						validateInput: v =>
							!v?.trim()
								? 'Organization is required'
								: /\s/.test(v.trim())
									? 'Use the organization slug, without spaces'
									: undefined,
					})
				)?.trim() ?? '';
		}
		if (!org) {
			return {
				added: false,
				cancelled: true,
				server: this.createAzureDevOpsMcpPreset('YOUR_ORG'),
			};
		}
		const server = this.createAzureDevOpsMcpPreset(org);
		state.mcpServers.push(server);
		await this.save(state);
		return { added: true, server };
	}

	/**
	 * Only migrate legacy vscode settings when the user actually configured
	 * a key or base URL. Never invent a fake OpenAI/gpt-4o server on first run.
	 */
	private seedFromLegacySettings(): AiSettingsState {
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		const apiKey = (cfg.get<string>('apiKey') ?? '').trim();
		const baseUrl = (cfg.get<string>('baseUrl') ?? '').trim();
		const kind = (cfg.get<string>('provider') as ServerKind) || 'openai';

		// Only migrate when the user actually configured something.
		if (!apiKey && !baseUrl) {
			const empty = emptyState();
			void this.context.globalState.update(STATE_KEY, empty);
			return empty;
		}

		const model = (cfg.get<string>('model') ?? '').trim();
		const numCtx = cfg.get<number>('contextBudget') ?? 32768;
		const server: AiServer = {
			id: randomUUID(),
			name: kindLabel(kind),
			kind,
			baseUrl: baseUrl || DEFAULT_BASE_URL[kind] || '',
			apiKey,
			models: model ? [model] : [],
			numCtx,
			forceJson: false,
			enabled: true,
		};
		if (!isUsableServer(server)) {
			const empty = emptyState();
			void this.context.globalState.update(STATE_KEY, empty);
			return empty;
		}
		const state: AiSettingsState = {
			servers: [server],
			activeServerId: server.id,
			activeModel: model || null,
			mcpServers: [],
		};
		void this.context.globalState.update(STATE_KEY, state);
		return state;
	}

	/** Remove previously auto-seeded cloud servers (fake gpt-4o etc.), keep user drafts. */
	private dropUnconfiguredPlaceholders(state: AiSettingsState): AiSettingsState {
		const kept = state.servers.filter(s => !looksLikeLegacyAutoSeed(s));
		if (kept.length === state.servers.length) {
			return state;
		}
		const next: AiSettingsState = {
			...state,
			servers: kept,
			activeServerId: kept.some(s => s.id === state.activeServerId)
				? state.activeServerId
				: kept[0]?.id ?? null,
			activeModel: kept.some(s => s.id === state.activeServerId)
				? state.activeModel
				: kept[0]?.models[0] ?? null,
		};
		if (!this.purgedPlaceholders) {
			this.purgedPlaceholders = true;
			void this.context.globalState.update(STATE_KEY, next);
		}
		return next;
	}

	private async syncActiveToWorkspaceSettings(state: AiSettingsState): Promise<void> {
		const server = state.servers.find(s => s.id === state.activeServerId);
		const cfg = vscode.workspace.getConfiguration('codeforge.ai');
		if (!server) {
			await Promise.all([
				cfg.update('provider', 'openai', vscode.ConfigurationTarget.Global),
				cfg.update('baseUrl', '', vscode.ConfigurationTarget.Global),
				cfg.update('apiKey', '', vscode.ConfigurationTarget.Global),
				cfg.update('model', '', vscode.ConfigurationTarget.Global),
			]);
			return;
		}
		const numCtx = server.numCtx && server.numCtx > 0 ? server.numCtx : 32768;
		await Promise.all([
			cfg.update('provider', server.kind, vscode.ConfigurationTarget.Global),
			cfg.update('baseUrl', server.baseUrl, vscode.ConfigurationTarget.Global),
			cfg.update('apiKey', server.apiKey ?? '', vscode.ConfigurationTarget.Global),
			cfg.update('model', state.activeModel ?? server.models[0] ?? '', vscode.ConfigurationTarget.Global),
			cfg.update('contextBudget', numCtx, vscode.ConfigurationTarget.Global),
		]);
	}
}

export function kindLabel(kind: ServerKind): string {
	switch (kind) {
		case 'openai': return 'OpenAI';
		case 'anthropic': return 'Anthropic';
		case 'google': return 'Google';
		case 'xai': return 'xAI';
		case 'openrouter': return 'OpenRouter';
		case 'ollama': return 'Ollama';
		case 'vllm': return 'vLLM';
		case 'lmstudio': return 'LM Studio';
		case 'custom': return 'Custom OpenAI-compatible';
		default: return kind;
	}
}

export function defaultModelsFor(kind: ServerKind): string[] {
	return [...(DEFAULT_MODELS[kind] ?? ['default'])];
}

export function defaultBaseUrlFor(kind: ServerKind): string {
	return DEFAULT_BASE_URL[kind] ?? '';
}

/** Merge catalogs by server id, then by kind+baseUrl+name. Prefer keys / richer model lists. */
export function mergeSettingsStates(a: AiSettingsState, b: AiSettingsState): AiSettingsState {
	const servers = new Map<string, AiServer>();
	const fingerprint = (s: AiServer) =>
		`${s.kind}::${(s.baseUrl || '').replace(/\/$/, '').toLowerCase()}::${(s.name || '').toLowerCase()}`;

	const upsert = (s: AiServer) => {
		const byId = servers.get(s.id);
		const byFp = [...servers.values()].find(x => fingerprint(x) === fingerprint(s));
		const existing = byId ?? byFp;
		if (!existing) {
			servers.set(s.id, { ...s, models: [...(s.models || [])] });
			return;
		}
		const merged: AiServer = {
			...existing,
			...s,
			id: existing.id,
			apiKey: (s.apiKey || '').trim() ? s.apiKey : existing.apiKey,
			baseUrl: (s.baseUrl || '').trim() ? s.baseUrl : existing.baseUrl,
			models: Array.from(new Set([...(existing.models || []), ...(s.models || [])])),
			numCtx: s.numCtx && s.numCtx > 0 ? s.numCtx : existing.numCtx,
			forceJson: s.forceJson === true || existing.forceJson === true,
			embeddingModel: s.embeddingModel || existing.embeddingModel,
			enabled: s.enabled !== false && existing.enabled !== false,
		};
		if (byFp && byFp.id !== existing.id) {
			servers.delete(byFp.id);
		}
		servers.set(existing.id, merged);
	};

	for (const s of a.servers || []) upsert(s);
	for (const s of b.servers || []) upsert(s);

	const list = [...servers.values()];
	const mcpById = new Map<string, McpServerConfig>();
	for (const m of [...(a.mcpServers || []), ...(b.mcpServers || [])]) {
		mcpById.set(m.id, { ...(mcpById.get(m.id) || {}), ...m });
	}

	const preferActive = (state: AiSettingsState): { serverId: string | null; model: string | null } => {
		if (state.activeServerId && list.some(s => s.id === state.activeServerId)) {
			const srv = list.find(s => s.id === state.activeServerId)!;
			const model =
				state.activeModel && srv.models.includes(state.activeModel)
					? state.activeModel
					: srv.models[0] ?? null;
			return { serverId: state.activeServerId, model };
		}
		return { serverId: null, model: null };
	};

	// Prefer current profile active (a), then b, then first usable.
	const fromA = preferActive(a);
	const fromB = preferActive(b);
	let activeServerId = fromA.serverId || fromB.serverId || list[0]?.id || null;
	let activeModel = fromA.model || fromB.model || list[0]?.models[0] || null;
	if (activeServerId) {
		const srv = list.find(s => s.id === activeServerId);
		if (srv && activeModel && !srv.models.includes(activeModel)) {
			activeModel = srv.models[0] ?? null;
		}
	}

	return {
		servers: list,
		activeServerId,
		activeModel,
		mcpServers: [...mcpById.values()],
	};
}
