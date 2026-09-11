/**
 * MCP client with proper stdio Content-Length framing + HTTP JSON-RPC.
 */

import * as vscode from 'vscode';
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

export class McpClientManager {
	private processes = new Map<string, ChildProcessWithoutNullStreams>();
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private buffers = new Map<string, Buffer>();
	private tools: McpToolDef[] = [];
	private httpMeta = new Map<string, McpServerConfig>();
	private readonly output: vscode.OutputChannel;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	listTools(): McpToolDef[] {
		return [...this.tools];
	}

	getHttpServer(serverId: string): McpServerConfig | undefined {
		return this.httpMeta.get(serverId);
	}

	async refresh(servers: McpServerConfig[]): Promise<void> {
		await this.dispose();
		for (const server of servers.filter(s => s.enabled)) {
			try {
				const transport =
					server.transport ??
					(server.url ? 'http' : server.command ? 'stdio' : undefined);
				if (transport === 'stdio' && server.command) {
					await this.connectStdio(server);
				} else if ((transport === 'http' || server.url) && server.url) {
					await this.connectHttp(server);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.output.appendLine(`[mcp] failed ${server.name}: ${msg}`);
			}
		}
		this.output.appendLine(
			`[mcp] loaded ${this.tools.length} tools from ${servers.filter(s => s.enabled).length} servers`
		);
	}

	async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
		const tool = this.tools.find(t => t.fullName === fullName || t.name === fullName);
		if (!tool) {
			throw new Error(`Unknown MCP tool: ${fullName}`);
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
		this.pending.clear();
		this.buffers.clear();
		this.tools = [];
		this.httpMeta.clear();
	}

	private async connectStdio(server: McpServerConfig): Promise<void> {
		const proc = spawn(server.command!, server.args ?? [], {
			env: { ...process.env, ...(server.env ?? {}) },
			shell: true,
		});
		this.processes.set(server.id, proc);
		this.buffers.set(server.id, Buffer.alloc(0));

		proc.stdout.on('data', (chunk: Buffer) => {
			this.onData(server.id, chunk);
		});
		proc.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8').trim();
			if (text) {
				this.output.appendLine(`[mcp:${server.name}] ${text}`);
			}
		});
		proc.on('exit', code => {
			this.output.appendLine(`[mcp:${server.name}] exited ${code}`);
			this.processes.delete(server.id);
		});

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
	}

	private onData(serverId: string, chunk: Buffer): void {
		const prev = this.buffers.get(serverId) ?? Buffer.alloc(0);
		let buf = Buffer.concat([prev, chunk]);

		while (true) {
			const headerEnd = indexOfDoubleCrlf(buf);
			if (headerEnd < 0) {
				this.buffers.set(serverId, buf);
				return;
			}
			const header = buf.subarray(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Fallback: try newline-delimited JSON for non-compliant servers
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
		const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;

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
			}, 30000);
		});
	}
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
