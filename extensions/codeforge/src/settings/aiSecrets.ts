/**
 * SecretStorage for API keys and MCP sensitive fields (not in settings.json / webview).
 */

import * as vscode from 'vscode';
import type { AiServer, McpServerConfig } from './aiSettingsStore';

export const MASKED_SECRET = '••••••••';

function serverKey(id: string): string {
	return `codeforge.ai.server.${id}.apiKey`;
}

function mcpApiKeyKey(id: string): string {
	return `codeforge.ai.mcp.${id}.apiKey`;
}

function mcpEnvKey(id: string): string {
	return `codeforge.ai.mcp.${id}.env`;
}

function mcpHeadersKey(id: string): string {
	return `codeforge.ai.mcp.${id}.headers`;
}

export async function loadServerSecrets(
	context: vscode.ExtensionContext,
	servers: AiServer[]
): Promise<AiServer[]> {
	const out: AiServer[] = [];
	for (const s of servers) {
		const stored = await context.secrets.get(serverKey(s.id));
		out.push({
			...s,
			apiKey: stored ?? s.apiKey,
		});
	}
	return out;
}

export async function persistServerSecret(
	context: vscode.ExtensionContext,
	serverId: string,
	apiKey: string | undefined
): Promise<void> {
	const key = serverKey(serverId);
	const trimmed = (apiKey ?? '').trim();
	if (!trimmed || trimmed === MASKED_SECRET) return;
	await context.secrets.store(key, trimmed);
}

export async function loadMcpSecrets(
	context: vscode.ExtensionContext,
	servers: McpServerConfig[]
): Promise<McpServerConfig[]> {
	const out: McpServerConfig[] = [];
	for (const m of servers) {
		const [apiKey, envJson, headersJson] = await Promise.all([
			context.secrets.get(mcpApiKeyKey(m.id)),
			context.secrets.get(mcpEnvKey(m.id)),
			context.secrets.get(mcpHeadersKey(m.id)),
		]);
		let env = m.env;
		let headers = m.headers;
		try {
			if (envJson) env = JSON.parse(envJson) as Record<string, string>;
		} catch {
			/* keep inline */
		}
		try {
			if (headersJson) headers = JSON.parse(headersJson) as Record<string, string>;
		} catch {
			/* keep inline */
		}
		out.push({
			...m,
			apiKey: apiKey ?? m.apiKey,
			env,
			headers,
		});
	}
	return out;
}

export async function persistMcpSecrets(
	context: vscode.ExtensionContext,
	server: McpServerConfig
): Promise<void> {
	const api = (server.apiKey ?? '').trim();
	if (api && api !== MASKED_SECRET) {
		await context.secrets.store(mcpApiKeyKey(server.id), api);
	}
	if (server.env && Object.keys(server.env).length) {
		await context.secrets.store(mcpEnvKey(server.id), JSON.stringify(server.env));
	}
	if (server.headers && Object.keys(server.headers).length) {
		await context.secrets.store(mcpHeadersKey(server.id), JSON.stringify(server.headers));
	}
}

export function maskStateForWebview<T extends { apiKey?: string; env?: Record<string, string>; headers?: Record<string, string> }>(
	item: T
): T {
	const next = { ...item };
	if (next.apiKey?.trim()) {
		next.apiKey = MASKED_SECRET;
	}
	if (next.env) {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(next.env)) {
			env[k] = secretLikeKey(k) && v?.trim() ? MASKED_SECRET : v;
		}
		next.env = env;
	}
	if (next.headers) {
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(next.headers)) {
			headers[k] = /authorization|token|secret|api-key/i.test(k) && v?.trim() ? MASKED_SECRET : v;
		}
		next.headers = headers;
	}
	return next;
}

function secretLikeKey(k: string): boolean {
	return /secret|token|password|api[_-]?key|authorization/i.test(k);
}

/** One-time migration from plaintext settings / globalState into SecretStorage. */
export async function migrateLegacySecretsToStorage(
	context: vscode.ExtensionContext,
	state: { servers: AiServer[]; mcpServers: McpServerConfig[] }
): Promise<void> {
	const flag = 'codeforge.ai.secretsMigrated.v1';
	if (context.globalState.get<boolean>(flag)) return;

	for (const s of state.servers) {
		if (s.apiKey?.trim()) {
			await context.secrets.store(serverKey(s.id), s.apiKey.trim());
		}
	}
	for (const m of state.mcpServers) {
		await persistMcpSecrets(context, m);
	}

	const cfg = vscode.workspace.getConfiguration('codeforge.ai');
	const legacyKey = (cfg.get<string>('apiKey') ?? '').trim();
	if (legacyKey && state.servers[0]) {
		await context.secrets.store(serverKey(state.servers[0].id), legacyKey);
	}

	await context.globalState.update(flag, true);
}
