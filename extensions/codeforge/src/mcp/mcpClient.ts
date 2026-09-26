/**
 * MCP client with stdio framing (Content-Length + NDJSON) + HTTP JSON-RPC.
 *
 * mcp-remote (Atlassian Rovo, etc.) speaks newline-delimited JSON on stdio.
 * Official SDK servers (@azure/mcp, @azure-devops/mcp, …) use Content-Length.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { McpServerConfig } from '../settings/aiSettingsStore';

export interface McpToolDef {
	serverId: string;
	serverName: string;
	name: string;
	fullName: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number | string;
	result?: unknown;
	error?: { message?: string; code?: number };
}

type StdioFraming = 'content-length' | 'ndjson';

export class McpClientManager {
	private processes = new Map<string, ChildProcessWithoutNullStreams>();
	private framing = new Map<string, StdioFraming>();
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private buffers = new Map<string, Buffer>();
	private tools: McpToolDef[] = [];
	private httpMeta = new Map<string, McpServerConfig>();
	private readonly output: vscode.OutputChannel;
	/** Last refresh summary for UI / commands */
	lastRefreshSummary = '';
	private refreshGen = 0;
	private refreshLock: Promise<void> = Promise.resolve();

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	listTools(): McpToolDef[] {
		return [...this.tools];
	}

	showOutput(preserveFocus = false): void {
		this.output.show(preserveFocus);
	}

	getHttpServer(serverId: string): McpServerConfig | undefined {
		return this.httpMeta.get(serverId);
	}

	async refresh(servers: McpServerConfig[]): Promise<void> {
		const run = async () => {
			const gen = ++this.refreshGen;
			const snap = {
				tools: [...this.tools],
				processes: new Map(this.processes),
				framing: new Map(this.framing),
				httpMeta: new Map(this.httpMeta),
				buffers: new Map(this.buffers),
			};

			const enabled = servers.filter(
				s => s.enabled && ((s.command ?? '').trim() || (s.url ?? '').trim())
			);
			for (const s of servers) {
				if (s.enabled && !(s.command ?? '').trim() && !(s.url ?? '').trim()) {
					this.output.appendLine(`[mcp] skip ${s.name || s.id}: empty command/url`);
				}
			}

			const failures: string[] = [];
			// Prefer mcp-remote (Atlassian) first so it is not delayed by Azure/ADO timeouts.
			const ordered = [...enabled].sort((a, b) => {
				const score = (s: McpServerConfig) =>
					/mcp-remote|atlassian/i.test([s.command, s.name, ...(s.args ?? [])].join(' '))
						? 0
						: 1;
				return score(a) - score(b);
			});

			// Stage into fresh maps; keep snap alive until we know the new catalog is usable.
			this.processes = new Map();
			this.framing = new Map();
			this.buffers = new Map();
			this.httpMeta = new Map();
			this.tools = [];

			const killMap = (procs: Map<string, ChildProcessWithoutNullStreams>) => {
				for (const [, p] of procs) {
					try {
						p.kill();
					} catch {
						/* ignore */
					}
				}
			};

			const restoreSnap = () => {
				killMap(this.processes);
				this.processes = snap.processes;
				this.framing = snap.framing;
				this.httpMeta = snap.httpMeta;
				this.buffers = snap.buffers;
				this.tools = snap.tools;
			};

			for (const server of ordered) {
				if (gen !== this.refreshGen) {
					restoreSnap();
					return;
				}
				const transport =
					server.transport ??
					(server.url ? 'http' : server.command ? 'stdio' : undefined);
				try {
					if (transport === 'stdio' && server.command) {
						await this.connectStdio(server);
					} else if ((transport === 'http' || server.url) && server.url) {
						await this.connectHttp(server);
					} else {
						this.output.appendLine(`[mcp] skip ${server.name}: no transport`);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.output.appendLine(`[mcp] failed ${server.name}: ${msg}`);
					failures.push(`${server.name}: ${msg}`);
					const proc = this.processes.get(server.id);
					if (proc) {
						try {
							proc.kill();
						} catch {
							/* ignore */
						}
						this.processes.delete(server.id);
						this.framing.delete(server.id);
					}
				}
			}

			if (gen !== this.refreshGen) {
				restoreSnap();
				return;
			}

			// Never replace a healthy catalog with an empty one (e.g. Azure hang + Atlassian flake).
			if (this.tools.length === 0 && snap.tools.length > 0 && enabled.length > 0) {
				restoreSnap();
				this.lastRefreshSummary = `Kept ${snap.tools.length} previous tool(s); refresh loaded 0. ${failures.join(' | ')}`;
				this.output.appendLine(`[mcp] ${this.lastRefreshSummary}`);
				return;
			}

			killMap(snap.processes);
			this.lastRefreshSummary =
				failures.length === 0
					? `Loaded ${this.tools.length} tool(s) from ${enabled.length} server(s).`
					: `Loaded ${this.tools.length} tool(s). Failures: ${failures.join(' | ')}`;
			this.output.appendLine(`[mcp] ${this.lastRefreshSummary}`);
		};

		this.refreshLock = this.refreshLock.then(run, run);
		await this.refreshLock;
	}

	async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
		const tool = this.tools.find(t => t.fullName === fullName || t.name === fullName);
		if (!tool) {
			const available = this.tools.map(t => t.fullName).slice(0, 40);
			const hint = available.length
				? ` Available: ${available.join(', ')}${this.tools.length > 40 ? '…' : ''}`
				: ' No MCP tools loaded — run CodeForge: Refresh MCP Servers (check Output → CodeForge MCP).';
			throw new Error(`Unknown MCP tool: ${fullName}.${hint}`);
		}
		if (this.processes.has(tool.serverId)) {
			const result = await this.rpc(tool.serverId, 'tools/call', {
				name: tool.name,
				arguments: args,
			});
			return formatMcpResult(result);
		}
		const http = this.httpMeta.get(tool.serverId);
		if (http?.url) {
			return this.invokeHttp(http.url, http.apiKey, tool.name, args);
		}
		throw new Error(`MCP server ${tool.serverName} is not connected`);
	}

	async invokeHttp(
		url: string,
		apiKey: string | undefined,
		name: string,
		args: Record<string, unknown>
	): Promise<string> {
		const body = {
			jsonrpc: '2.0',
			id: this.nextId++,
			method: 'tools/call',
			params: { name, arguments: args },
		};
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
		}
		const data = (await res.json()) as JsonRpcResponse;
		if (data.error) {
			throw new Error(data.error.message ?? 'MCP error');
		}
		return formatMcpResult(data.result);
	}

	async dispose(): Promise<void> {
		for (const [, proc] of this.processes) {
			try {
				proc.kill();
			} catch {
				/* ignore */
			}
		}
		this.processes.clear();
		this.framing.clear();
		this.pending.clear();
		this.buffers.clear();
		this.tools = [];
		this.httpMeta.clear();
	}

	private async connectStdio(server: McpServerConfig): Promise<void> {
		const framing = detectStdioFraming(server);
		const { command, args } = resolveStdioSpawn(server);
		this.output.appendLine(
			`[mcp] starting ${server.name} (${framing}): ${command} ${args.join(' ')}`
		);

		const readyHint = /mcp-remote/i.test([server.command, ...(server.args ?? [])].join(' '));
		const readyPromise = readyHint ? deferred<void>() : undefined;

		const proc = spawn(command, args, {
			env: { ...process.env, ...(server.env ?? {}) },
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.processes.set(server.id, proc);
		this.framing.set(server.id, framing);
		this.buffers.set(server.id, Buffer.alloc(0));

		proc.stdout.on('data', (chunk: Buffer) => {
			this.onData(server.id, chunk);
		});
		proc.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			const trimmed = text.trim();
			if (trimmed) {
				this.output.appendLine(`[mcp:${server.name}] ${trimmed.slice(0, 500)}`);
			}
			if (
				readyPromise &&
				/Local STDIO server running|Proxy established successfully/i.test(text)
			) {
				readyPromise.resolve();
			}
		});
		proc.on('error', err => {
			this.output.appendLine(`[mcp:${server.name}] spawn error: ${err.message}`);
		});
		proc.on('exit', code => {
			this.output.appendLine(`[mcp:${server.name}] exited ${code}`);
			this.processes.delete(server.id);
			this.framing.delete(server.id);
		});

		if (readyPromise) {
			await Promise.race([
				readyPromise.promise,
				sleep(25_000).then(() => {
					throw new Error(
						'Timed out waiting for mcp-remote (OAuth / proxy). Complete browser login if prompted, then Refresh MCP again.'
					);
				}),
			]);
		} else {
			// Give SDK servers a moment to bind stdin.
			await sleep(400);
		}

		await this.rpc(server.id, 'initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'codeforge', version: '0.1.0' },
		});
		await this.rpc(server.id, 'notifications/initialized', {});
		const listed = (await this.rpc(server.id, 'tools/list', {})) as {
			tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
		};
		for (const t of listed.tools ?? []) {
			this.tools.push({
				serverId: server.id,
				serverName: server.name,
				name: t.name,
				fullName: `${sanitizeName(server.name)}__${t.name}`,
				description: t.description,
				inputSchema: t.inputSchema,
			});
		}
		this.output.appendLine(
			`[mcp] ${server.name}: ${(listed.tools ?? []).length} tool(s)`
		);
	}

	private async connectHttp(server: McpServerConfig): Promise<void> {
		const url = server.url!;
		const body = {
			jsonrpc: '2.0',
			id: this.nextId++,
			method: 'tools/list',
			params: {},
		};
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}: ${await res.text()}`);
		}
		const data = (await res.json()) as JsonRpcResponse;
		if (data.error) {
			throw new Error(data.error.message ?? 'MCP list error');
		}
		const result = data.result as {
			tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
		};
		for (const t of result?.tools ?? []) {
			this.tools.push({
				serverId: server.id,
				serverName: server.name,
				name: t.name,
				fullName: `${sanitizeName(server.name)}__${t.name}`,
				description: t.description,
				inputSchema: t.inputSchema,
			});
		}
		this.httpMeta.set(server.id, server);
		this.output.appendLine(
			`[mcp] ${server.name}: ${(result?.tools ?? []).length} tool(s) (http)`
		);
	}

	private onData(serverId: string, chunk: Buffer): void {
		const prev = this.buffers.get(serverId) ?? Buffer.alloc(0);
		let buf = Buffer.concat([prev, chunk]);
		const framing = this.framing.get(serverId) ?? 'content-length';

		if (framing === 'ndjson') {
			while (true) {
				const nl = buf.indexOf(0x0a);
				if (nl < 0) {
					this.buffers.set(serverId, buf);
					return;
				}
				const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim();
				buf = buf.subarray(nl + 1);
				if (line.startsWith('{')) {
					this.handleMessage(line);
				}
			}
		}

		while (true) {
			const headerEnd = indexOfDoubleCrlf(buf);
			if (headerEnd < 0) {
				// Fallback: NDJSON line (some servers mix)
				const nl = buf.indexOf(0x0a);
				if (nl < 0) {
					this.buffers.set(serverId, buf);
					return;
				}
				const line = buf.subarray(0, nl).toString('utf8').trim();
				buf = buf.subarray(nl + 1);
				if (line.startsWith('{')) {
					this.handleMessage(line);
				}
				continue;
			}
			const header = buf.subarray(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				const nl = buf.indexOf(0x0a);
				if (nl < 0) {
					this.buffers.set(serverId, buf);
					return;
				}
				const line = buf.subarray(0, nl).toString('utf8').trim();
				buf = buf.subarray(nl + 1);
				if (line.startsWith('{')) {
					this.handleMessage(line);
				}
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (buf.length < bodyStart + length) {
				this.buffers.set(serverId, buf);
				return;
			}
			const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8');
			buf = buf.subarray(bodyStart + length);
			this.handleMessage(body);
		}
	}

	private handleMessage(raw: string): void {
		try {
			const msg = JSON.parse(raw) as JsonRpcResponse;
			if (msg.id === undefined) return;
			const id = Number(msg.id);
			const p = this.pending.get(id);
			if (!p) return;
			this.pending.delete(id);
			if (msg.error) {
				p.reject(new Error(msg.error.message ?? 'RPC error'));
			} else {
				p.resolve(msg.result);
			}
		} catch (err) {
			this.output.appendLine(`[mcp] bad message: ${String(err)}`);
		}
	}

	private rpc(serverId: string, method: string, params: unknown): Promise<unknown> {
		const proc = this.processes.get(serverId);
		if (!proc) {
			return Promise.reject(new Error('MCP process not running'));
		}
		const id = this.nextId++;
		const isNotification = method.startsWith('notifications/');
		const payloadObj = isNotification
			? { jsonrpc: '2.0', method, params }
			: { jsonrpc: '2.0', id, method, params };
		const payload = JSON.stringify(payloadObj);
		const framing = this.framing.get(serverId) ?? 'content-length';
		const frame =
			framing === 'ndjson'
				? `${payload}\n`
				: `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;

		return new Promise((resolve, reject) => {
			if (isNotification) {
				proc.stdin.write(frame);
				resolve({});
				return;
			}
			this.pending.set(id, { resolve, reject });
			proc.stdin.write(frame);
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP timeout: ${method}`));
				}
			}, framing === 'ndjson' ? 45_000 : 15_000);
		});
	}
}

function detectStdioFraming(server: McpServerConfig): StdioFraming {
	const blob = [server.command, ...(server.args ?? [])].join(' ');
	// mcp-remote local side uses newline-delimited JSON (not Content-Length).
	if (/mcp-remote/i.test(blob)) return 'ndjson';
	return 'content-length';
}

/**
 * Avoid `shell: true` on Windows — stdin often never reaches the MCP process.
 * Prefer `node npx-cli.js …` when the command is npx.
 * Important: in the VS Code / Electron extension host, `process.execPath` is the
 * editor binary — not Node — so we resolve a real `node` from PATH.
 */
function resolveStdioSpawn(server: McpServerConfig): { command: string; args: string[] } {
	const cmd = (server.command ?? '').trim();
	const args = [...(server.args ?? [])];
	if (/^npx(\.cmd)?$/i.test(cmd)) {
		const nodePath = findNodeExecutable();
		const npxCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
		return { command: nodePath, args: [npxCli, ...args] };
	}
	return { command: cmd, args };
}

function findNodeExecutable(): string {
	// Real Node (not Electron / CodeForgeZ.exe).
	if (/[/\\]node(\.exe)?$/i.test(process.execPath)) {
		return process.execPath;
	}
	try {
		const { execFileSync } = require('child_process') as typeof import('child_process');
		if (process.platform === 'win32') {
			const out = execFileSync('where.exe', ['node'], {
				encoding: 'utf8',
				windowsHide: true,
			});
			const first = out
				.split(/\r?\n/)
				.map(s => s.trim())
				.find(s => /node\.exe$/i.test(s) && !/electron/i.test(s));
			if (first) return first;
		} else {
			const out = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
			if (out) return out;
		}
	} catch {
		/* fall through */
	}
	const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
	const candidates = [
		path.join(programFiles, 'nodejs', 'node.exe'),
		path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'),
		'/usr/local/bin/node',
		'/usr/bin/node',
	];
	for (const c of candidates) {
		try {
			const { accessSync, constants } = require('fs') as typeof import('fs');
			accessSync(c, constants.X_OK);
			return c;
		} catch {
			/* try next */
		}
	}
	// Last resort — may still fail in Electron host.
	return process.platform === 'win32' ? 'node.exe' : 'node';
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function indexOfDoubleCrlf(buf: Buffer): number {
	for (let i = 0; i < buf.length - 3; i++) {
		if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function formatMcpResult(result: unknown): string {
	if (result == null) return '(empty)';
	if (typeof result === 'string') return result;
	const r = result as { content?: Array<{ type?: string; text?: string }> };
	if (Array.isArray(r.content)) {
		return r.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
	}
	return JSON.stringify(result, null, 2);
}

let sharedMcp: McpClientManager | undefined;

export function initMcp(output: vscode.OutputChannel): McpClientManager {
	sharedMcp = new McpClientManager(output);
	return sharedMcp;
}

export function getMcp(): McpClientManager | undefined {
	return sharedMcp;
}
