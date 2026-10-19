/**
 * Scripted e2e: floor-model protocol (XML / aliased names / arg aliases / indent-tolerant edit).
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { callTool, reply } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

const SAMPLE = `export function greet(name: string): string {
  return "hi " + name;
}
`;

const SAMPLE_FIXED = `export function greet(name: string): string {
  return "hello " + name;
}
`;

describe('q2-behavior (protocol floor)', () => {
	it('XML or aliased read_file + edit with old_str/wrong indent finishes with correct file', async () => {
		const result = await runLoop({
			files: { 'src/Greeter.ts': SAMPLE },
			task: 'Change greet to return hello instead of hi.',
			script: [
				// Content-side XML with aliased tool + arg name (floor model style).
				reply({
					content: [
						'<think>I will read the file</think>',
						'<tool_call>',
						'<function=read_file>',
						'<parameter=file_path>',
						'src/Greeter.ts',
						'</parameter>',
						'</function>',
						'</tool_call>',
					].join('\n'),
				}),
				// Aliased args + wrong indent on old_string (tabs vs spaces).
				callTool('edit', {
					path: 'src/Greeter.ts',
					old_str: '\treturn "hi " + name;',
					new_string: '\treturn "hello " + name;',
				}),
				reply({ content: 'Updated Greeter.ts', finish_reason: 'stop' }),
			],
			maxSteps: 12,
		});

		expect(result.files.get('src/Greeter.ts')).toBe(SAMPLE_FIXED);
		const toolBlob = JSON.stringify(result.activities);
		expect(toolBlob).not.toMatch(/no tool named read_file/i);
	}, 90_000);

	it('native read_file with file_path also works via normalizer', async () => {
		const result = await runLoop({
			files: { 'src/Greeter.ts': SAMPLE },
			task: 'Fix greet return value.',
			script: [
				callTool('read_file', { file_path: 'src/Greeter.ts' }),
				callTool('str_replace', {
					path: 'src/Greeter.ts',
					old_str: 'return "hi " + name;',
					new_str: 'return "hello " + name;',
				}),
				reply({ content: 'done' }),
			],
			maxSteps: 10,
		});
		expect(result.files.get('src/Greeter.ts')).toBe(SAMPLE_FIXED);
	}, 90_000);

	it('identical re-read is marked unchanged since step N', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			askMode: true,
			task: 'Read a.ts twice.',
			script: [
				callTool('read', { path: 'a.ts' }),
				callTool('read', { path: 'a.ts' }),
				reply({ content: 'a.ts has const x = 1' }),
			],
			maxSteps: 8,
		});
		const blob = JSON.stringify(result.requests);
		expect(blob).toMatch(/unchanged since step \d+/);
	}, 60_000);

	it('weak profile refuses a single write over 180 lines', async () => {
		const big = Array.from({ length: 200 }, (_, i) => `line${i}();`).join('\n');
		const result = await runLoop({
			files: { 'seed.txt': 'x\n' },
			weakProfile: true,
			task: 'Create big.ts with many lines.',
			script: [
				callTool('write', { path: 'big.ts', content: big }),
				callTool('write', {
					path: 'big.ts',
					content: 'export const ok = 1;\n',
				}),
				reply({ content: 'wrote skeleton' }),
			],
			maxSteps: 10,
		});
		const blob = JSON.stringify(result.requests);
		expect(blob).toMatch(/limit 180|Not written: content is 20\d+ lines/i);
		expect(result.files.get('big.ts')).toBe('export const ok = 1;\n');
	}, 60_000);
});
