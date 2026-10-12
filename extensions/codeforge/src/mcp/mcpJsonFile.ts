/**
 * Load MCP servers from Cursor-compatible mcp.json files.
 *
 * Spec aligned with https://cursor.com/docs/mcp :
 * - Global:  ~/.cursor/mcp.json
 * - Project: {workspace}/.cursor/mcp.json  (wins on same server name)
 * - Product mirrors (same schema): ~/.CodeForge/mcp.json, {workspace}/.CodeForge/mcp.json
 *
 * Schema fields: type, command, args, env, envFile, url, headers, auth, disabled/enabled
 * Interpolation: ${env:NAME}, ${userHome}, ${workspaceFolder}, ${workspaceFolderBasename},
 * ${pathSeparator}, ${/}, plus legacy ${NAME} for env keys.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { homeRoot } from '../storage/paths';
import type { McpServerConfig } from '../settings/aiSettingsStore';

interface CursorMcpAuth {
	CLIENT_ID?: string;
	CLIENT_SECRET?: string;
	scopes?: string[];
}

interface CursorMcpEntry {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	envFile?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: CursorMcpAuth;
	transport?: string;
	disabled?: boolean;
	enabled?: boolean;
}

interface CursorMcpFile {
	mcpServers?: Record<string, CursorMcpEntry>;
}

export interface McpJsonInterpContext {
	workspaceFolder?: string;
}

/** Canonical CodeForge user MCP file (Cursor schema). */
export function codeforgeMcpJsonFile(): string {
	return path.join(homeRoot(), 'mcp.json');
}

/**
 * Cursor merge order: global then project (project wins).
 * CodeForge mirrors use the same schema and slot beside Cursor paths.
 */
export function resolveMcpJsonPaths(workspaceFolder?: string): string[] {
	const paths = [path.join(os.homedir(), '.cursor', 'mcp.json'), codeforgeMcpJsonFile()];
	if (workspaceFolder) {
		paths.push(
			path.join(workspaceFolder, '.cursor', 'mcp.json'),
			path.join(workspaceFolder, '.CodeForge', 'mcp.json')
		);
	}
	return paths;
}

/** Parse KEY=VALUE lines from a .env file (stdio envFile, Cursor-compatible). */
export function parseEnvFile(filePath: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!fs.existsSync(filePath)) return out;
	const text = fs.readFileSync(filePath, 'utf8');
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let val = trimmed.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

function interpolate(
	value: string,
	ctx: McpJsonInterpContext,
	envBag: Record<string, string>
): string {
	let out = value;
	out = out.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
		if (Object.prototype.hasOwnProperty.call(envBag, name) && envBag[name] != null) {
			return String(envBag[name]);
		}
		return process.env[name] ?? '';
	});
	out = out.replace(/\$\{userHome\}/g, os.homedir());
	const ws = ctx.workspaceFolder ?? '';
	out = out.replace(/\$\{workspaceFolder\}/g, ws);
	out = out.replace(/\$\{workspaceFolderBasename\}/g, ws ? path.basename(ws) : '');
	out = out.replace(/\$\{pathSeparator\}/g, path.sep);
	out = out.replace(/\$\{\/\}/g, path.sep);
	// Legacy Cursor/community: ${NAME} without env: prefix
	out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
		if (name === 'userHome' || name === 'workspaceFolder' || name === 'workspaceFolderBasename') {
			return _;
		}
		if (Object.prototype.hasOwnProperty.call(envBag, name) && envBag[name] != null) {
			return String(envBag[name]);
		}
		return process.env[name] ?? '';
	});
	return out;
}

function resolveTransport(
	entry: CursorMcpEntry,
	hasUrl: boolean,
	hasCommand: boolean
): 'stdio' | 'http' | undefined {
	const t = (entry.type ?? entry.transport ?? '').toLowerCase();
	if (t === 'http' || t === 'sse' || t === 'streamable-http' || t === 'streamable_http') {
		return 'http';
	}
	if (t === 'stdio' || t === 'local') {
		return 'stdio';
	}
	if (hasUrl && !hasCommand) return 'http';
	if (hasCommand) return 'stdio';
	return undefined;
}

function entryToConfig(
	id: string,
	entry: CursorMcpEntry,
	ctx: McpJsonInterpContext
): McpServerConfig | undefined {
	const envRaw = { ...(entry.env ?? {}) };
	// envFile first (Cursor: only for STDIO); values can still be interpolated below
	let envFilePath = entry.envFile?.trim();
	if (envFilePath) {
		envFilePath = interpolate(envFilePath, ctx, envRaw);
		if (!path.isAbsolute(envFilePath) && ctx.workspaceFolder) {
			envFilePath = path.resolve(ctx.workspaceFolder, envFilePath);
		}
		Object.assign(envRaw, parseEnvFile(envFilePath));
	}

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(envRaw)) {
		env[k] = interpolate(String(v), ctx, envRaw);
	}

	const url = entry.url?.trim() ? interpolate(entry.url.trim(), ctx, env) : undefined;
	const command = entry.command?.trim()
		? interpolate(entry.command.trim(), ctx, env)
		: undefined;
	const args = (entry.args ?? []).map(a => interpolate(String(a), ctx, env));

	const headersRaw = entry.headers ?? {};
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(headersRaw)) {
		headers[k] = interpolate(String(v), ctx, env);
	}

	const transport = resolveTransport(entry, !!url, !!command);
	if (!transport) return undefined;
	if (transport === 'http' && !url) return undefined;
	if (transport === 'stdio' && !command) return undefined;

	const enabled =
		entry.disabled === true ? false : entry.enabled === false ? false : true;

	// Convenience: Authorization Bearer from auth is not Cursor's model (OAuth is interactive),
	// but if headers already set Authorization we keep it; apiKey remains UI fallback.
	const apiKeyFromHeader = headers.Authorization?.replace(/^Bearer\s+/i, '').trim();

	return {
		id,
		name: id,
		transport,
		command: command || undefined,
		args: args.length ? args : undefined,
		url: url || undefined,
		headers: Object.keys(headers).length ? headers : undefined,
		env: Object.keys(env).length ? env : undefined,
		envFile: envFilePath || undefined,
		apiKey: apiKeyFromHeader || undefined,
		enabled,
	};
}

function readOneFile(
	filePath: string,
	ctx: McpJsonInterpContext,
	log?: (line: string) => void
): McpServerConfig[] {
	if (!fs.existsSync(filePath)) {
		return [];
	}
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = JSON.parse(raw) as CursorMcpFile;
		const map = parsed?.mcpServers;
		if (!map || typeof map !== 'object' || Array.isArray(map)) {
			log?.(`[mcp.json] ${filePath}: missing mcpServers object`);
			return [];
		}
		const out: McpServerConfig[] = [];
		for (const [id, entry] of Object.entries(map)) {
			if (!id?.trim() || !entry || typeof entry !== 'object') continue;
			const cfg = entryToConfig(id.trim(), entry, ctx);
			if (cfg) out.push(cfg);
		}
		log?.(`[mcp.json] ${filePath}: ${out.length} server(s)`);
		return out;
	} catch (err) {
		log?.(
			`[mcp.json] failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
		);
		return [];
	}
}

/** Load Cursor-format mcp.json from standard locations (later path wins on same id). */
export function loadMcpServersFromJsonFiles(
	workspaceFolder?: string,
	log?: (line: string) => void
): McpServerConfig[] {
	const ctx: McpJsonInterpContext = { workspaceFolder };
	const byId = new Map<string, McpServerConfig>();
	for (const file of resolveMcpJsonPaths(workspaceFolder)) {
		for (const s of readOneFile(file, ctx, log)) {
			byId.set(s.id, s);
		}
	}
	return [...byId.values()];
}

/**
 * Merge settings UI MCP with file-based MCP.
 * File entries win on the same id (mcp.json is the Cursor-compatible source of truth).
 */
export function mergeMcpServerLists(
	fileServers: McpServerConfig[],
	settingsServers: McpServerConfig[]
): McpServerConfig[] {
	const byId = new Map<string, McpServerConfig>();
	for (const s of settingsServers) {
		byId.set(s.id, s);
	}
	for (const s of fileServers) {
		byId.set(s.id, s);
	}
	return [...byId.values()];
}

/** Ensure ~/.CodeForge/mcp.json exists with empty Cursor schema (idempotent). */
export async function ensureCodeforgeMcpJson(): Promise<void> {
	const file = codeforgeMcpJsonFile();
	try {
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		if (!fs.existsSync(file)) {
			await fs.promises.writeFile(
				file,
				`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
				'utf8'
			);
		}
	} catch {
		/* ignore */
	}
}

/**
 * Parse a Cursor-compatible mcp.json snippet:
 * - full file `{ "mcpServers": { "id": { ... } } }`
 * - map `{ "id": { ... } }`
 * - single entry `"id": { ... }` (wrapped automatically)
 */
export function parseCursorMcpSnippet(
	text: string,
	ctx: McpJsonInterpContext = {}
): McpServerConfig[] {
	let raw = text.trim().replace(/,\s*$/, '');
	if (!raw) throw new Error('Paste is empty');
	// Allow a bare `"name": { ... }` entry (Cursor mcpServers value shape).
	if (raw.startsWith('"') && !raw.startsWith('{')) {
		raw = `{${raw}}`;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Expected a JSON object');
	}
	const obj = parsed as Record<string, unknown>;
	let map: Record<string, CursorMcpEntry>;
	if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
		map = obj.mcpServers as Record<string, CursorMcpEntry>;
	} else if (
		typeof obj.command === 'string' ||
		typeof obj.url === 'string' ||
		Array.isArray(obj.args)
	) {
		throw new Error('Include a server name key, e.g. "my-server": { "command": "npx", ... }');
	} else {
		map = obj as Record<string, CursorMcpEntry>;
	}
	const out: McpServerConfig[] = [];
	for (const [id, entry] of Object.entries(map)) {
		if (!id?.trim() || !entry || typeof entry !== 'object') continue;
		const cfg = entryToConfig(id.trim(), entry, ctx);
		if (cfg) out.push(cfg);
	}
	if (!out.length) {
		throw new Error('No valid MCP servers found (need command or url)');
	}
	return out;
}

/** Load one Cursor-format mcp.json file (tenant or project). */
export function loadCursorMcpJsonFile(
	filePath: string,
	ctx: McpJsonInterpContext = {},
	log?: (line: string) => void
): McpServerConfig[] {
	return readOneFile(filePath, ctx, log);
}

/** Write servers as Cursor-compatible `{ mcpServers: { ... } }`. */
export function writeCursorMcpJsonFile(
	filePath: string,
	servers: McpServerConfig[],
	opts?: { redactEnvValues?: boolean }
): void {
	const mcpServers: Record<string, Record<string, unknown>> = {};
	for (const s of servers) {
		const entry: Record<string, unknown> = {};
		const isHttp = s.transport === 'http' || (!!s.url && !s.command);
		if (isHttp) {
			if (s.url) entry.url = s.url;
			if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers;
		} else {
			if (s.command) entry.command = s.command;
			if (s.args?.length) entry.args = s.args;
		}
		if (s.env && Object.keys(s.env).length) {
			if (opts?.redactEnvValues) {
				const placeholders: Record<string, string> = {};
				for (const k of Object.keys(s.env)) {
					placeholders[k] = `\${env:${k}}`;
				}
				entry.env = placeholders;
			} else {
				entry.env = s.env;
			}
		}
		if (s.enabled === false) entry.disabled = true;
		mcpServers[s.id] = entry;
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, 'utf8');
}
