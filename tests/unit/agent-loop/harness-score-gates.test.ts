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
	it('lets an existing test file gain tests, but refuses changing its assertions', async () => {
		const original = 'public class CartTests\n{\n\t[Fact]\n\tpublic void A() { Assert.Equal(30m, Totals.Subtotal()); }\n}\n';
		const appended = original.replace(
			'}\n}\n',
			'}\n\t[Fact]\n\tpublic void Coupon() { Assert.Equal(3m, Coupons.ApplyCoupon()); }\n}\n'
		);
		const result = await runLoop({
			files: {
				'src/Coupons.cs': 'public static class Coupons { }\n',
				'tests/Acme.Tests/CartTests.cs': original,
			},
			task: 'Implement Coupons.ApplyCoupon.',
			script: [
				callTool('read', { path: 'tests/Acme.Tests/CartTests.cs' }),
				callTool('write', { path: 'tests/Acme.Tests/CartTests.cs', content: appended }),
				callTool('edit', {
					path: 'tests/Acme.Tests/CartTests.cs',
					old_string: 'Assert.Equal(30m, Totals.Subtotal());',
					new_string: 'Assert.Equal(20m, Totals.Subtotal());',
				}),
				...Array.from({ length: 6 }, () => reply({ content: 'Added a coupon test.' })),
			],
			maxSteps: 14,
		});
		expect(result.files.get('tests/Acme.Tests/CartTests.cs')).toBe(appended);
		const toolResults = result.requests.map(r => messagesText(r.body)).join('\n');
		expect(toolResults).toMatch(/an assertion changed or disappeared/);
	}, 60_000);

	it('lets existing tests follow a rename the turn made in the source', async () => {
		const tax = 'function calcTax(n) { return n * 0.23; }\nmodule.exports = { calcTax };\n';
		const testBody = "const { calcTax } = require('../src/tax');\nassert.strictEqual(calcTax(100), 23);\n";
		const result = await runLoop({
			files: { 'src/tax.js': tax, 'test/tax.test.js': testBody, 'package.json': '{"name":"x"}' },
			task: 'Rename calcTax to computeTax.',
			script: [
				callTool('read', { path: 'src/tax.js' }),
				callTool('write', { path: 'src/tax.js', content: tax.replace(/calcTax/g, 'computeTax') }),
				callTool('read', { path: 'test/tax.test.js' }),
				callTool('write', { path: 'test/tax.test.js', content: testBody.replace(/calcTax/g, 'computeTax') }),
				...Array.from({ length: 6 }, () => reply({ content: 'Renamed calcTax to computeTax.' })),
			],
			maxSteps: 14,
		});
		expect(result.files.get('test/tax.test.js')).toContain('assert.strictEqual(computeTax(100), 23);');
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

	it('without a recorded verification, the agent finds and records it before finishing (any stack)', async () => {
		const verify = 'node -e "process.exit(0)"';
		const result = await runLoop({
			files: {
				'pyproject.toml': '[project]\nname = "cart"\n',
				'README.md': `# Cart\n\nCheck everything with \`${verify}\`.\n`,
				'src/cart.py': 'def total(items):\n    return 0\n',
			},
			task: 'Make total return the sum of the item prices.',
			script: [
				callTool('read', { path: 'src/cart.py' }),
				callTool('write', { path: 'src/cart.py', content: 'def total(items):\n    return sum(i.price for i in items)\n' }),
				reply({ content: 'total now sums the prices.' }),
				callTool('read', { path: 'README.md' }),
				callTool('set_verify_command', { commands: [verify] }),
				...Array.from({ length: 6 }, () => reply({ content: 'total now sums the prices.' })),
			],
			maxSteps: 16,
		});
		expect(result.activities.filter(a => a.label === 'Finish refused — no verification recorded')).toHaveLength(1);
		expect(JSON.parse(result.files.get('.CodeForge/oracle.json') ?? '{}')).toEqual({ commands: [verify] });
		const recorded = result.requests.map(r => messagesText(r.body)).find(t => t.includes('Recorded in .CodeForge/oracle.json'));
		expect(recorded).toContain('GREEN');
		expect(result.reply).not.toMatch(/no build\/test was verified/);
	}, 60_000);

	it('does not record a program the shell cannot find; records `none` with its reason', async () => {
		const result = await runLoop({
			files: { 'notes/plan.md': '# Plan\n- one\n' },
			task: 'Add a second item to notes/plan.md.',
			script: [
				callTool('read', { path: 'notes/plan.md' }),
				callTool('write', { path: 'notes/plan.md', content: '# Plan\n- one\n- two\n' }),
				reply({ content: 'Added the item.' }),
				callTool('set_verify_command', { commands: ['cf-no-such-program-xyz --check'] }),
				callTool('set_verify_command', { none: 'notes only, nothing to build or test' }),
				...Array.from({ length: 6 }, () => reply({ content: 'Added the second item.' })),
			],
			maxSteps: 16,
		});
		const text = result.requests.map(r => messagesText(r.body)).join('\n');
		expect(text).toMatch(/Not recorded: the shell could not find the program/);
		expect(JSON.parse(result.files.get('.CodeForge/oracle.json') ?? '{}')).toEqual({
			none: 'notes only, nothing to build or test',
		});
		expect(result.reply).toMatch(/no automated verification \(notes only, nothing to build or test\)/);
	}, 60_000);

	it('after a green verification, asks to run the changed code once, without naming a language', async () => {
		const result = await runLoop({
			files: {
				'.CodeForge/oracle.json': '{"command":"node -e 0"}',
				'src/coupons.js': 'module.exports = {};\n',
			},
			task: 'Implement applyCoupon in src/coupons.js.',
			script: [
				callTool('read', { path: 'src/coupons.js' }),
				callTool('write', {
					path: 'src/coupons.js',
					content: 'function applyCoupon(cart) { return cart.total * 0.1; }\nmodule.exports = { applyCoupon };\n',
				}),
				...Array.from({ length: 6 }, () => reply({ content: 'applyCoupon is implemented.' })),
			],
			maxSteps: 14,
		});
		const asked = result.requests
			.flatMap(r => (r.body.messages ?? []) as Array<{ content?: unknown }>)
			.map(m => (typeof m.content === 'string' ? m.content : ''))
			.find(c => c.startsWith('RUNTIME VERIFY'));
		expect(asked).toBeDefined();
		expect(asked).toContain("using the project's own language and runtime");
		expect(asked).not.toMatch(/dotnet|npm|node -e/);
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
