/**
 * Phase 4: CORE-only build surface by default; toolGroups enable extras.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { callTool, reply } from './support/scriptedModel';
import { runLoop } from './support/runLoop';
import { CORE } from '../../../extensions/codeforge/src/agent/toolPermissions';

describe('tool groups (phase 4)', () => {
	it('build requests expose only CORE tools by default', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Read a.ts and summarize.',
			script: [callTool('read', { path: 'a.ts' }), reply({ content: 'x=1' })],
			maxSteps: 6,
		});
		const tools = (result.requests[0]?.body.tools ?? []) as Array<{
			function?: { name?: string };
		}>;
		const names = tools.map(t => t.function?.name).filter(Boolean) as string[];
		expect(names.length).toBeGreaterThan(0);
		for (const n of names) {
			expect([...CORE, 'mcp_call']).toContain(n);
		}
		expect(names).not.toContain('git_status');
		expect(names).not.toContain('web_search');
		expect(names).not.toContain('browser_navigate');
		expect(names).not.toContain('delete');
	}, 60_000);

	it('enabling git toolGroup adds git tools', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Read a.ts.',
			script: [callTool('read', { path: 'a.ts' }), reply({ content: 'ok' })],
			maxSteps: 6,
			config: { 'codeforge.ai.toolGroups': ['git'] },
		});
		const tools = (result.requests[0]?.body.tools ?? []) as Array<{
			function?: { name?: string };
		}>;
		const names = tools.map(t => t.function?.name).filter(Boolean) as string[];
		expect(names).toContain('git_status');
		expect(names).toContain('git_commit');
		expect(names).not.toContain('web_search');
	}, 60_000);
});

describe('diagnostics after edit (phase 4.3)', () => {
	it('appends diagnostics block to successful edit', async () => {
		const sample = `export const x: number = 1;\n`;
		const fixed = `export const x: number = 2;\n`;
		const result = await runLoop({
			files: { 'src/A.ts': sample },
			task: 'Change x to 2.',
			script: [
				callTool('read', { path: 'src/A.ts' }),
				callTool('edit', {
					path: 'src/A.ts',
					old_string: 'export const x: number = 1;',
					new_string: 'export const x: number = 2;',
				}),
				reply({ content: 'done' }),
			],
			maxSteps: 8,
			diagnostics: {
				'src/A.ts': [
					{
						message: "Type 'string' is not assignable to type 'number'",
						severity: 0,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
					},
				],
			},
		});
		expect(result.files.get('src/A.ts')).toBe(fixed);
		const toolMsgs = result.requests
			.flatMap(r => (r.body.messages ?? []) as Array<{ role?: string; content?: string }>)
			.filter(m => m.role === 'tool')
			.map(m => m.content ?? '')
			.join('\n');
		expect(toolMsgs).toMatch(/Diagnostics for src\/A\.ts/i);
		expect(toolMsgs).toMatch(/Type 'string' is not assignable/i);
	}, 90_000);
});
