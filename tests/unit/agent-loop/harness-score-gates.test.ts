/**
 * Loop-level gates behind the CS2 / CS4 / CS6 live-run losses on 2026-11-02.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import * as fs from 'fs';
import * as path from 'path';
import { callTool, reply, type ScriptedRequestBody, type ScriptedStep } from './support/scriptedModel';
import { runLoop } from './support/runLoop';
import { PLAN_FILE } from '../../../extensions/codeforge/src/agent/orchestrator';

function messagesText(body: ScriptedRequestBody): string {
	return JSON.stringify(body.messages ?? []);
}

describe('harness score gates', () => {
	it('refuses to append tests to a test file that existed before the turn (CS2)', async () => {
		const original = 'public class CartTests\n{\n\t[Fact]\n\tpublic void A() { Assert.True(true); }\n}\n';
		const result = await runLoop({
			files: {
				'src/Coupons.cs': 'public static class Coupons { }\n',
				'tests/Acme.Tests/CartTests.cs': original,
			},
			task: 'Implement Coupons.ApplyCoupon.',
			script: [
				callTool('read', { path: 'tests/Acme.Tests/CartTests.cs' }),
				callTool('edit', {
					path: 'tests/Acme.Tests/CartTests.cs',
					old_string: '\tpublic void A() { Assert.True(true); }',
					new_string:
						'\tpublic void A() { Assert.True(true); }\n\t[Fact]\n\tpublic void Coupon() { Assert.Equal(1, 1); }',
				}),
				reply({ content: 'Added a coupon test.' }),
			],
			maxSteps: 10,
		});
		expect(result.files.get('tests/Acme.Tests/CartTests.cs')).toBe(original);
		const toolResults = result.requests.map(r => messagesText(r.body)).join('\n');
		expect(toolResults).toMatch(/existed before this turn/);
	}, 60_000);

	it('refuses to finish while new .NET projects have no solution in the workspace root (CS4)', async () => {
		const result = await runLoop({
			files: {
				'docs/C01.md': '# C01\nCreate the solution.\n',
				'.CodeForge/oracle.json': '{"command":"node -e 0"}',
			},
			task: 'Read docs/C01.md and create the .NET solution it describes.',
			script: [
				callTool('write', { path: 'Acme.Router/Acme.Router.slnx', content: '<Solution />\n' }),
				callTool('write', {
					path: 'src/Acme.Router.Domain/Acme.Router.Domain.csproj',
					content: '<Project Sdk="Microsoft.NET.Sdk" />\n',
				}),
				reply({ content: 'The solution is ready.' }),
				callTool('write', { path: 'Acme.Router.slnx', content: '<Solution />\n' }),
				callTool('delete', { path: 'Acme.Router/Acme.Router.slnx' }),
				reply({ content: 'Moved the solution to the workspace root.' }),
			],
			maxSteps: 14,
		});
		const refused = result.activities.filter(a => a.label === 'Finish refused — no solution in the workspace root');
		expect(refused).toHaveLength(1);
		expect(refused[0].detail).toBe('Acme.Router/Acme.Router.slnx');
		expect(result.files.has('Acme.Router.slnx')).toBe(true);
		const afterRefusal = result.requests.map(r => messagesText(r.body)).find(t => t.includes('MSB1003'));
		expect(afterRefusal).toBeDefined();
	}, 60_000);

	it('an update_status-only step does not end a work turn before the finish gates (T2)', async () => {
		const result = await runLoop({
			files: {
				'src/a.js': 'module.exports = 1;\n',
				'.CodeForge/oracle.json': '{"command":"node -e 0"}',
			},
			task: 'Change src/a.js to export 2.',
			script: [
				callTool('read', { path: 'src/a.js' }),
				callTool('edit', { path: 'src/a.js', old_string: 'module.exports = 1;', new_string: 'module.exports = 2;' }),
				callTool('update_status', {
					objective: 'Export 2 from src/a.js',
					stoppedAt: 'Edited src/a.js',
					next: 'Nothing left',
				}),
				...Array.from({ length: 6 }, () => reply({ content: 'src/a.js now exports 2.' })),
			],
			maxSteps: 12,
		});
		expect(result.files.get('src/a.js')).toBe('module.exports = 2;\n');
		expect(result.reply).not.toMatch(/^update_status/);
		expect(result.reply).toMatch(/src\/a\.js now exports 2/);
	}, 60_000);

	it('a reply that repeats the harness note is not accepted as the answer (T3)', async () => {
		const echoLastNote: ScriptedStep = body => {
			const last = (body.messages ?? []).at(-1) as { content?: unknown } | undefined;
			return { content: typeof last?.content === 'string' ? last.content : '' };
		};
		const result = await runLoop({
			files: { 'hello.txt': 'Hello, World!\n' },
			task: 'Read hello.txt and say what it contains.',
			askMode: true,
			script: [
				reply({ content: '' }),
				echoLastNote,
				callTool('read', { path: 'hello.txt' }),
				reply({ content: 'hello.txt contains Hello, World!' }),
			],
			maxSteps: 8,
		});
		expect(result.reply).toBe('hello.txt contains Hello, World!');
	}, 60_000);

	it('does not mark a card done when its sub-run used no tool (CS6 C05)', async () => {
		const card: ScriptedStep = body => {
			const text = messagesText(body);
			if (text.includes('Item 1 of 2')) {
				return text.includes('"role":"tool"')
					? { content: 'C01 done.' }
					: { content: '', tool_calls: [{ name: 'write', arguments: { path: 'src/one.txt', content: 'one\n' } }] };
			}
			return { content: '1. Read the existing code\n2. Implement Resolve in RouteTable' };
		};
		const result = await runLoop({
			files: {
				'docs/C01.md': '# C01 — One\n\nWrite src/one.txt.\n',
				'docs/C02.md': '# C02 — Two\n\nDepends on: C01\n\nAdd Resolve.\n',
			},
			task: 'Implement the cards docs/C01.md to docs/C02.md in dependency order.',
			script: Array.from({ length: 40 }, () => card),
			orchestrated: true,
			maxSteps: 10,
		});
		expect(result.reply).toMatch(/Progress \(1\/2 done\)/);
		expect(result.reply).toMatch(/C02 is blocked/);
		expect(result.reply).toMatch(/without changing any file or running any command/);
		const plan = JSON.parse(
			fs.readFileSync(path.join(result.workspaceRoot, PLAN_FILE), 'utf8')
		) as { items: Array<{ id: string; status: string }> };
		expect(plan.items.find(i => i.id === 'C02')?.status).toBe('blocked');
	}, 120_000);
});
