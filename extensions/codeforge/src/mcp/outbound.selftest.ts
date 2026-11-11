/**
 * Outbound MCP requires bearer token; /health stays open; tools reject without auth.
 */
import * as http from 'http';
import { startOutboundMcp, stopOutboundMcp, getOutboundMcpStatus } from './outbound';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

async function get(
	port: number,
	pathName: string,
	headers?: Record<string, string>
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: '127.0.0.1', port, path: pathName, method: 'GET', headers },
			res => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer | string) => {
					chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
				});
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
				);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

export async function run(): Promise<void> {
	await stopOutboundMcp();
	let threw = false;
	try {
		await startOutboundMcp({ port: 19847, bearerToken: '' });
	} catch {
		threw = true;
	}
	assert(threw, 'empty token refused');

	const status = await startOutboundMcp({ port: 19847, bearerToken: 'test-token-abc' });
	assert(status.running === true, 'started');
	assert(typeof status.port === 'number', 'has port');
	const port = status.port!;

	const health = await get(port, '/health');
	assert(health.status === 200, 'health open');

	const toolsNoAuth = await get(port, '/mcp/tools');
	assert(toolsNoAuth.status === 401, 'tools require auth');

	const toolsAuth = await get(port, '/mcp/tools', { Authorization: 'Bearer test-token-abc' });
	assert(toolsAuth.status === 200, 'tools with bearer');
	assert(/wiki_list/.test(toolsAuth.body), 'lists wiki tools');

	await stopOutboundMcp();
	assert(getOutboundMcpStatus().running === false, 'stopped');
	console.log('outbound.selftest: ok');
}
