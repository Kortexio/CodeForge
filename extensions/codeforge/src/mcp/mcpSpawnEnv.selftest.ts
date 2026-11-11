/**
 * MCP spawn env allowlist + @latest refusal helpers.
 */
import { buildMcpSpawnEnv, mcpArgsUseLatest } from './mcpSpawnEnv';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(mcpArgsUseLatest(['-y', 'mcp-remote@latest']), 'detect @latest');
assert(mcpArgsUseLatest(['@azure/mcp@latest']), 'detect azure @latest');
assert(!mcpArgsUseLatest(['-y', 'mcp-remote@0.16.5']), 'pinned ok');
assert(!mcpArgsUseLatest(undefined), 'empty ok');

const host: NodeJS.ProcessEnv = {
	PATH: '/bin',
	OPENAI_API_KEY: 'sk-secret',
	AWS_SECRET_ACCESS_KEY: 'aws-secret',
	USERPROFILE: 'C:\\Users\\dev',
	HOME: '/home/dev',
	TEMP: '/tmp',
};
const env = buildMcpSpawnEnv({ CUSTOM: 'from-file' }, { MCP_TOKEN: 'tok' }, host);
assert(env.PATH === '/bin', 'keeps PATH');
assert(env.USERPROFILE === 'C:\\Users\\dev' || env.HOME === '/home/dev', 'keeps profile');
assert(env.OPENAI_API_KEY === undefined, 'strips host secrets');
assert(env.AWS_SECRET_ACCESS_KEY === undefined, 'strips AWS');
assert(env.CUSTOM === 'from-file', 'keeps file env');
assert(env.MCP_TOKEN === 'tok', 'keeps server env');

console.log('mcpSpawnEnv.selftest: ok');
