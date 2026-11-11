/**
 * Agent CORE includes git/web/browser/files/glob/wiki/media/notebook.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { callTool, reply } from './support/scriptedModel';
import { runLoop } from './support/runLoop';
import { CORE } from '../../../extensions/codeforge/src/agent/toolPermissions';

describe('tool groups (phase 4)', () => {
	it('build requests expose CORE including git/web/browser/files/glob/wiki/media/notebook', async () => {
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
		expect(names).toContain('git_status');
		expect(names).toContain('web_search');
		expect(names).toContain('browser_navigate');
		expect(names).toContain('delete');
		expect(names).toContain('glob');
		expect(names).toContain('wiki_read');
		expect(names).toContain('wiki_write');
		expect(names).toContain('generate_image');
		expect(names).toContain('canvas_write');
		expect(names).toContain('edit_notebook');
		expect(names).not.toContain('mcp_call');
	}, 60_000);

	it('glob returns matching files from findFiles, not a stub', async () => {
		const result = await runLoop({
			files: {
				'src/A.ts': 'export const a = 1;\n',
				'src/B.cs': 'class B {}\n',
				'README.md': '# hi\n',
			},
			task: 'Find TypeScript files.',
			script: [callTool('glob', { pattern: '**/*.ts' }), reply({ content: 'found A.ts' })],
			maxSteps: 6,
		});
		const toolMsgs = result.requests
			.flatMap(r => (r.body.messages ?? []) as Array<{ role?: string; content?: string }>)
			.filter(m => m.role === 'tool')
			.map(m => m.content ?? '')
			.join('\n');
		expect(toolMsgs).toMatch(/src\/A\.ts/);
		expect(toolMsgs).not.toMatch(/src\/B\.cs/);
		expect(toolMsgs).not.toMatch(/^ok$/m);
		expect(toolMsgs).not.toMatch(/coming soon|not implemented|would run here/i);
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
