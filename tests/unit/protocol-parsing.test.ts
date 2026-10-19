/**
 * Protocol robustness for content-side tool calls (trailing commas, Windows paths,
 * glued calls, think tags, unclosed XML).
 */
import {
	parseProseToolCalls,
	parseToolArguments,
} from '../../extensions/codeforge/src/agent/agentLoop';
import { parseXmlToolCalls } from '../../extensions/codeforge/src/agent/xmlToolCalls';

describe('protocol parsing', () => {
	it('parseToolArguments tolerates trailing commas', () => {
		const args = parseToolArguments('{ "path": "a.ts", "startLine": 1, }');
		expect(args.path).toBe('a.ts');
		expect(args.startLine).toBe(1);
	});

	it('parseToolArguments repairs Windows backslashes in JSON strings', () => {
		const args = parseToolArguments('{ "path": "src\\Greeter.ts", "limit": 40 }');
		expect(String(args.path)).toMatch(/Greeter\.ts$/);
		expect(args.limit).toBe(40);
	});

	it('parseProseToolCalls lifts trailing-comma tool JSON', () => {
		const calls = parseProseToolCalls(
			'{"name":"read","arguments":{"path":"a.ts","limit":10,},}'
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.function.name).toBe('read');
		const args = JSON.parse(calls[0]!.function.arguments) as { path: string; limit: number };
		expect(args.path).toBe('a.ts');
		expect(args.limit).toBe(10);
	});

	it('parseProseToolCalls repairs Windows paths in content JSON', () => {
		const calls = parseProseToolCalls(
			'{"name":"read","arguments":{"path":"C:\\Users\\me\\proj\\src\\a.ts"}}'
		);
		expect(calls).toHaveLength(1);
		const args = JSON.parse(calls[0]!.function.arguments) as { path: string };
		expect(args.path.replace(/\\/g, '/')).toMatch(/src\/a\.ts$/);
	});

	it('parseProseToolCalls lifts glued tool calls', () => {
		const calls = parseProseToolCalls(
			'{"name":"read","arguments":{"path":"a.ts"}}{"name":"read","arguments":{"path":"b.ts"}}'
		);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.map(c => c.function.name)).toEqual(['read', 'read']);
		const paths = calls.map(c => (JSON.parse(c.function.arguments) as { path: string }).path);
		expect(paths).toEqual(['a.ts', 'b.ts']);
	});

	it('parseProseToolCalls ignores think tags before a call', () => {
		const calls = parseProseToolCalls(
			'<think>I should read the file first</think>\n{"name":"read","arguments":{"path":"a.ts"}}'
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.function.name).toBe('read');
	});

	it('parseXmlToolCalls handles unclosed tool_call', () => {
		const calls = parseXmlToolCalls(
			'<tool_call>\n<function=read>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n'
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.function.name).toBe('read');
		const args = JSON.parse(calls[0]!.function.arguments) as { path: string };
		expect(args.path.trim()).toBe('src/a.ts');
	});

	it('parseXmlToolCalls strips think and lifts XML', () => {
		const calls = parseXmlToolCalls(
			'<think>plan</think><tool_call><function=list><parameter=path>.</parameter></function></tool_call>'
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.function.name).toBe('list');
	});

	it('parseProseToolCalls lifts XML via xml fallback', () => {
		const calls = parseProseToolCalls(
			'<tool_call><function=search><parameter=pattern>greet</parameter></function></tool_call>'
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.function.name).toBe('search');
	});
});
