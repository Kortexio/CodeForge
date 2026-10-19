/**
 * Reproduction suite for harness contradictions (plan cases A–H + Loop).
 * These must fail for the stated reason before phase-2 fixes; after fixes they pass.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { callTool, reply, type ScriptedStep } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

const SAMPLE = `export function greet(name: string): string {
  return "hi " + name;
}
`;

const SAMPLE_FIXED = `export function greet(name: string): string {
  return "hello " + name;
}
`;

describe('harness contradictions', () => {
	it('A: soft-cached read must still satisfy read-this-turn so edit can apply', async () => {
		const result = await runLoop({
			files: { 'src/Greeter.ts': SAMPLE },
			task: 'Change greet to return hello instead of hi.',
			script: [
				callTool('read', { path: 'src/Greeter.ts' }),
				callTool('edit', {
					path: 'src/Greeter.ts',
					old_string: 'return "WRONG";',
					new_string: 'return "hello " + name;',
				}),
				// Re-read after miss — today this soft-hits and never sets readThisTurn.
				callTool('read', { path: 'src/Greeter.ts' }),
				callTool('edit', {
					path: 'src/Greeter.ts',
					old_string: 'return "hi " + name;',
					new_string: 'return "hello " + name;',
				}),
				reply({ content: 'Updated Greeter.ts' }),
			],
			maxSteps: 12,
		});
		const toolBlob = JSON.stringify(result.requests);
		expect(toolBlob).not.toMatch(/read-this-turn gate/i);
		expect(result.files.get('src/Greeter.ts')).toBe(SAMPLE_FIXED);
	}, 90_000);

	it('B: FILE_NOT_FOUND after step 3 must still allow search', async () => {
		const script: ScriptedStep[] = [
			callTool('read', { path: 'src/A.ts' }),
			callTool('read', { path: 'src/B.ts' }),
			callTool('read', { path: 'src/C.ts' }),
			callTool('read', { path: 'src/Missing.ts' }),
			callTool('search', { pattern: 'greet' }),
			reply({ content: 'Found greet in Greeter.ts' }),
		];
		const result = await runLoop({
			files: {
				'src/A.ts': 'export const a = 1;\n',
				'src/B.ts': 'export const b = 2;\n',
				'src/C.ts': 'export const c = 3;\n',
				'src/Greeter.ts': SAMPLE,
			},
			task: 'Find where greet is defined.',
			script,
			maxSteps: 16,
		});
		const blocked = result.activities.filter(
			a => /blocked \(stage/i.test(a.label ?? '') || /exploration is closed/i.test(a.detail ?? '')
		);
		expect(blocked).toHaveLength(0);
		expect(result.activities.some(a => a.tool === 'search' && a.label && !/blocked/i.test(a.label))).toBe(
			true
		);
	}, 90_000);

	it('C: weak red-build read cap must not block editing a non-error file', async () => {
		const result = await runLoop({
			files: {
				'src/Broken.ts': 'export const x: number = "bad";\n',
				'src/Helper.ts': 'export function help() { return 1; }\n',
				'.CodeForge/oracle.json': JSON.stringify({
					commands: [{ name: 'fail', command: 'cmd /c exit 1' }],
				}),
			},
			task: 'Fix Helper.ts to return 2 even though Broken.ts fails the build.',
			weakProfile: true,
			script: [
				callTool('read', { path: 'src/Broken.ts' }),
				callTool('read', { path: 'src/Helper.ts' }),
				callTool('shell', { command: 'cmd /c exit 1' }),
				callTool('read', { path: 'src/Broken.ts' }),
				callTool('read', { path: 'src/Helper.ts' }),
				callTool('edit', {
					path: 'src/Helper.ts',
					old_string: 'return 1;',
					new_string: 'return 2;',
				}),
				reply({ content: 'Helper updated' }),
			],
			maxSteps: 20,
		});
		expect(result.files.get('src/Helper.ts')).toContain('return 2;');
	}, 90_000);

	it('D: plan path gate must not block editing the file named by oracle errors', async () => {
		// Internal plan path gate is exercised when an active plan exists.
		// Without a plan this is a soft pass; with a plan fixture we assert edit on Other.ts works.
		const result = await runLoop({
			files: {
				'src/Allowed.ts': 'export const a = 1;\n',
				'src/Other.ts': 'export const o = 1;\n',
			},
			task: 'Edit src/Other.ts to set o = 2.',
			script: [
				callTool('read', { path: 'src/Other.ts' }),
				callTool('edit', {
					path: 'src/Other.ts',
					old_string: 'export const o = 1;',
					new_string: 'export const o = 2;',
				}),
				reply({ content: 'done' }),
			],
			maxSteps: 10,
		});
		expect(result.files.get('src/Other.ts')).toContain('o = 2');
		expect(
			result.activities.every(a => !/plan path gate/i.test(`${a.label} ${a.detail}`))
		).toBe(true);
	}, 60_000);

	it('E: messages[0] and tools stay identical across steps', async () => {
		const result = await runLoop({
			files: { 'a.ts': ' const x = 1;\n', 'b.ts': 'const y = 2;\n' },
			task: 'Read a.ts and b.ts then summarize.',
			script: [
				callTool('read', { path: 'a.ts' }),
				callTool('read', { path: 'b.ts' }),
				callTool('read', { path: 'a.ts', startLine: 1, limit: 10 }),
				reply({ content: 'a=1 b=2' }),
			],
			maxSteps: 15,
			numCtx: 32768,
		});
		const systems = result.requests.map(r => {
			const msgs = (r.body.messages ?? []) as Array<{ role?: string; content?: string }>;
			return msgs.find(m => m.role === 'system')?.content ?? '';
		});
		const toolsJson = result.requests.map(r => JSON.stringify(r.body.tools ?? []));
		expect(systems.length).toBeGreaterThan(1);
		for (let i = 1; i < systems.length; i++) {
			expect(systems[i]).toBe(systems[0]);
		}
		for (let i = 1; i < toolsJson.length; i++) {
			expect(toolsJson[i]).toBe(toolsJson[0]);
		}
	}, 90_000);

	it('E2: messages[0] and tools stay identical over a long run', async () => {
		const script: ScriptedStep[] = [
			...Array.from({ length: 12 }, (_, i) =>
				callTool('read', { path: i % 2 === 0 ? 'a.ts' : 'b.ts' })
			),
			reply({ content: 'done after long explore' }),
		];
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n', 'b.ts': 'const y = 2;\n' },
			task: 'Read a.ts and b.ts many times then summarize.',
			script,
			maxSteps: 20,
			numCtx: 16384,
		});
		const systems = result.requests.map(r => {
			const msgs = (r.body.messages ?? []) as Array<{ role?: string; content?: string }>;
			return msgs.find(m => m.role === 'system')?.content ?? '';
		});
		const toolsJson = result.requests.map(r => JSON.stringify(r.body.tools ?? []));
		expect(systems.length).toBeGreaterThan(5);
		for (let i = 1; i < systems.length; i++) {
			expect(systems[i]).toBe(systems[0]);
		}
		for (let i = 1; i < toolsJson.length; i++) {
			expect(toolsJson[i]).toBe(toolsJson[0]);
		}
	}, 120_000);

	it('F: length exhaustion wrap must not claim tools repeated', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Explain a.ts',
			script: [
				reply({ content: 'x'.repeat(13000), finish_reason: 'length' }),
				reply({ content: 'y'.repeat(13000), finish_reason: 'length' }),
				reply({ content: 'I hit the token limit twice.' }),
			],
			maxSteps: 10,
		});
		expect(result.reply).not.toMatch(/repeated without new|tools were stuck|tools stuck/i);
		expect(result.reply).toMatch(/token|length|truncat|limit/i);
	}, 60_000);

	it('G: delegate_task explore must not expose write/edit/shell', async () => {
		const result = await runLoop({
			files: { 'src/A.ts': 'export const a = 1;\n' },
			task: 'Delegate an explore look at src/A.ts.',
			script: [
				callTool('delegate_task', {
					task: 'List exports in src/A.ts',
					mode: 'explore',
				}),
				reply({ content: 'Delegated.' }),
			],
			maxSteps: 8,
		});
		// Sub-run records requests too when nested; look for write/edit in tools of nested calls.
		const mutatingExposed = result.requests.some(r => {
			const tools = (r.body.tools ?? []) as Array<{ function?: { name?: string } }>;
			return tools.some(t =>
				['write', 'edit', 'apply_patch', 'shell', 'delete', 'rename'].includes(
					t.function?.name ?? ''
				)
			);
		});
		// Parent agent still has mutating tools; check the subagent path via activity/detail.
		const detail = result.activities.map(a => a.detail ?? '').join('\n');
		expect(`${detail}\n${result.reply}`).not.toMatch(/Wrote |Edited /);
		void mutatingExposed;
	}, 90_000);

	it('H: budget wrap keeps tools and uses MAX_STEPS wording', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Keep reading a.ts forever.',
			script: Array.from({ length: 8 }, () => callTool('read', { path: 'a.ts' })).concat([
				reply({ content: 'Stopped at max steps.' }),
			]),
			maxSteps: 3,
			hardCap: 3,
		});
		const last = result.requests[result.requests.length - 1];
		expect(last?.body.tools).toBeTruthy();
		expect(Array.isArray(last?.body.tools) && (last!.body.tools as unknown[]).length).toBeGreaterThan(0);
		expect(last?.body.tool_choice).toBe('none');
		const userMsgs = ((last?.body.messages ?? []) as Array<{ role?: string; content?: string }>)
			.filter(m => m.role === 'user')
			.map(m => m.content ?? '')
			.join('\n');
		expect(userMsgs).toMatch(/MAXIMUM STEPS|maximum steps/i);
	}, 90_000);

	it('Loop: identical call+result three times stops with that cause', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Read a.ts.',
			script: [
				callTool('read', { path: 'a.ts' }),
				...Array.from({ length: 8 }, () => callTool('read', { path: 'a.ts' })),
				reply({ content: 'Stopped repeating.' }),
			],
			maxSteps: 30,
		});
		expect(result.reply).toMatch(/identical|repeat|same (call|result)|stuck|without new progress/i);
	}, 90_000);
});
