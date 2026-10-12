/**
 * MCP outbound — expose project wiki + retrieve to external MCP clients (HTTP loopback).
 */

import * as http from 'http';
import { getProjectWikiStore } from '../memory/projectWiki';

export interface OutboundMcpStatus {
	running: boolean;
	port?: number;
	url?: string;
}

let server: http.Server | undefined;
let listenPort: number | undefined;

export function getOutboundMcpStatus(): OutboundMcpStatus {
	return {
		running: !!server,
		port: listenPort,
		url: listenPort ? `http://127.0.0.1:${listenPort}/mcp` : undefined,
	};
}

function createOutboundHandler(fallbackPort: number): http.RequestListener {
	return async (req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Content-Type', 'application/json');

		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? '/', `http://127.0.0.1:${listenPort ?? fallbackPort}`);

		if (req.method === 'GET' && url.pathname === '/health') {
			res.writeHead(200);
			res.end(JSON.stringify({ ok: true, service: 'codeforge-mcp-outbound' }));
			return;
		}

		if (req.method === 'GET' && url.pathname === '/mcp/tools') {
			res.writeHead(200);
			res.end(
				JSON.stringify({
					tools: [
						{
							name: 'wiki_list',
							description: 'List project wiki documents',
						},
						{
							name: 'wiki_read',
							description: 'Read a project wiki document by id',
							inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
						},
						{
							name: 'wiki_search',
							description: 'Search project wiki',
							inputSchema: {
								type: 'object',
								properties: { query: { type: 'string' } },
								required: ['query'],
							},
						},
						{
							name: 'wiki_facts',
							description: 'List current temporal facts',
						},
					],
				})
			);
			return;
		}

		if (req.method === 'POST' && url.pathname === '/mcp/call') {
			const body = await readBody(req);
			let parsed: { tool?: string; arguments?: Record<string, unknown> };
			try {
				parsed = JSON.parse(body || '{}');
			} catch {
				res.writeHead(400);
				res.end(JSON.stringify({ error: 'invalid JSON' }));
				return;
			}
			try {
				const result = await handleTool(parsed.tool ?? '', parsed.arguments ?? {});
				res.writeHead(200);
				res.end(JSON.stringify({ ok: true, result }));
			} catch (err) {
				res.writeHead(500);
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		res.writeHead(404);
		res.end(JSON.stringify({ error: 'not found' }));
	};
}

async function listenOnPort(tryPort: number, preferredPort: number): Promise<void> {
	server = http.createServer(createOutboundHandler(preferredPort));
	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			server?.off('listening', onListening);
			reject(err);
		};
		const onListening = () => {
			server?.off('error', onError);
			listenPort = tryPort;
			resolve();
		};
		server!.once('error', onError);
		server!.listen(tryPort, '127.0.0.1', onListening);
	});
}

/** Prefer `port`, then port+1 … port+9 when EADDRINUSE (multi-instance / parallel IDEs). */
export async function startOutboundMcp(port = 3847): Promise<OutboundMcpStatus> {
	if (server) return getOutboundMcpStatus();

	const lastPort = port + 9;
	let lastErr: unknown;
	for (let tryPort = port; tryPort <= lastPort; tryPort++) {
		try {
			await listenOnPort(tryPort, port);
			return getOutboundMcpStatus();
		} catch (err) {
			lastErr = err;
			const code =
				err && typeof err === 'object' && 'code' in err
					? String((err as NodeJS.ErrnoException).code)
					: undefined;
			const failed = server as http.Server | undefined;
			server = undefined;
			listenPort = undefined;
			if (failed) {
				try {
					failed.close();
				} catch {
					/* ignore */
				}
			}
			if (code === 'EADDRINUSE' && tryPort < lastPort) {
				continue;
			}
			throw err;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(`No free port in ${port}-${lastPort}`);
}

export async function stopOutboundMcp(): Promise<void> {
	if (!server) return;
	await new Promise<void>(resolve => server!.close(() => resolve()));
	server = undefined;
	listenPort = undefined;
}

async function handleTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
	const wiki = getProjectWikiStore();
	switch (tool) {
		case 'wiki_list':
			return wiki.listDocuments().map(d => ({ id: d.id, title: d.title, summary: d.summary }));
		case 'wiki_read': {
			const doc = wiki.getDocument(String(args.id ?? ''));
			if (!doc) throw new Error('document not found');
			return doc;
		}
		case 'wiki_search':
			return wiki.search(String(args.query ?? ''), 8);
		case 'wiki_facts':
			return wiki.currentFacts();
		default:
			throw new Error(`unknown tool: ${tool}`);
	}
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
