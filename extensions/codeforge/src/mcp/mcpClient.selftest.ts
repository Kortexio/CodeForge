import { formatMcpResult } from './mcpResultFormat';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(formatMcpResult({ isError: true, content: [{ type: 'text', text: 'bad input' }] }).startsWith('Error:'), 'isError prefixes Error:');
assert(
	formatMcpResult({ content: [{ type: 'error', text: 'denied' }] }).startsWith('Error:'),
	'error content type prefixes Error:'
);
const big = 'x'.repeat(30_000);
const clipped = formatMcpResult({ content: [{ text: big }] }, 1000);
assert(clipped.length <= 1100, 'size-limits MCP result');
assert(clipped.includes('clipped') || clipped.length < big.length, 'clip marker or shorter');

console.log('mcpClient.selftest: ok');
