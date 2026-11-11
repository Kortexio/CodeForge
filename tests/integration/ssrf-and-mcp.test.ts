/**
 * Production-boundary integration checks (SSRF, MCP env scrub, outbound auth).
 */
import * as http from 'http';
import {
	assertSafeFetchUrlSync,
	isBlockedIp,
} from '../../extensions/codeforge/src/agent/webTools';
import { buildMcpSpawnEnv, mcpArgsUseLatest } from '../../extensions/codeforge/src/mcp/mcpSpawnEnv';
import {
	startOutboundMcp,
	stopOutboundMcp,
} from '../../extensions/codeforge/src/mcp/outbound';
import { redactSecrets } from '../../extensions/codeforge/src/storage/redactSecrets';
import { isBlockedCommand } from '../../extensions/codeforge/src/sandbox/runtime';

describe('production boundary', () => {
	afterAll(async () => {
		await stopOutboundMcp();
	});

	it('blocks private/loopback web_fetch URLs', () => {
		expect(assertSafeFetchUrlSync('http://127.0.0.1/')).toMatch(/SSRF|blocked/i);
		expect(assertSafeFetchUrlSync('http://169.254.169.254/')).toMatch(/SSRF|blocked/i);
		expect(assertSafeFetchUrlSync('https://example.com/a')).toBeUndefined();
		expect(isBlockedIp('10.1.2.3')).toBe(true);
	});

	it('scrubs host secrets from MCP spawn env and rejects @latest', () => {
		const env = buildMcpSpawnEnv(
			{},
			{ TOKEN: 'ok' },
			{ PATH: '/bin', OPENAI_API_KEY: 'sk-leak', HOME: '/home/x' }
		);
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.TOKEN).toBe('ok');
		expect(mcpArgsUseLatest(['mcp-remote@latest'])).toBe(true);
		expect(mcpArgsUseLatest(['mcp-remote@0.16.5'])).toBe(false);
	});

	it('requires bearer auth on outbound MCP tools', async () => {
		await stopOutboundMcp();
		const status = await startOutboundMcp({ port: 19857, bearerToken: 'integ-token' });
		expect(status.running).toBe(true);
		const port = status.port!;

		const health = await httpGet(port, '/health');
		expect(health.status).toBe(200);

		const denied = await httpGet(port, '/mcp/tools');
		expect(denied.status).toBe(401);

		const ok = await httpGet(port, '/mcp/tools', { Authorization: 'Bearer integ-token' });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatch(/wiki_list/);
	});

	it('redacts secrets in traces and blocks download cradles', () => {
		expect(redactSecrets('Bearer sk-abcdefghijklmnop')).toMatch(/REDACTED/);
		expect(isBlockedCommand('iex (New-Object Net.WebClient)')).toBeTruthy();
	});
});

function httpGet(
	port: number,
	pathName: string,
	headers?: Record<string, string>
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: '127.0.0.1', port, path: pathName, method: 'GET', headers },
			res => {
				const chunks: Buffer[] = [];
				res.on('data', c => chunks.push(c));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8'),
					})
				);
			}
		);
		req.on('error', reject);
		req.end();
	});
}
