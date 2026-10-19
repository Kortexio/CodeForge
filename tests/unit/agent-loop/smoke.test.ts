/**
 * Smoke: runLoop can execute a trivial scripted turn.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { callTool, reply } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

describe('runLoop smoke', () => {
	it('reads a file and finishes', async () => {
		const result = await runLoop({
			files: { 'hello.txt': 'Hello, World!\n' },
			task: 'Read hello.txt and say what it contains.',
			askMode: true,
			script: [
				callTool('read', { path: 'hello.txt' }),
				reply({ content: 'hello.txt contains Hello, World!' }),
			],
			maxSteps: 8,
			isolated: true,
		});
		expect(result.reply).toMatch(/Hello/i);
		expect(result.requests.length).toBeGreaterThanOrEqual(2);
		expect(result.activities.some(a => a.tool === 'read')).toBe(true);
	}, 60_000);

	it('search scoped to a folder returns matches from that folder only', async () => {
		const result = await runLoop({
			files: {
				'src/Billing/Errors.cs': 'public class InvalidCouponException : Exception {}\n',
				'docs/notes.md': 'InvalidCouponException is documented here\n',
			},
			task: 'Where is InvalidCouponException defined?',
			askMode: true,
			script: [
				callTool('search', { pattern: 'class .*Exception', path: 'src' }),
				reply({ content: 'It is defined in src/Billing/Errors.cs.' }),
			],
			maxSteps: 8,
			isolated: true,
		});
		const second = JSON.stringify(result.requests[1]?.body.messages ?? []);
		expect(second).not.toMatch(/RelativePattern/);
		expect(second).toMatch(/Errors\.cs/);
		expect(second).not.toMatch(/notes\.md/);
	}, 60_000);

	it('an echoed /no_think reply is treated as empty, not as the final answer', async () => {
		const result = await runLoop({
			files: { 'hello.txt': 'Hello, World!\n' },
			task: 'Read hello.txt and say what it contains.',
			askMode: true,
			script: [
				reply({ content: '/no_think' }),
				callTool('read', { path: 'hello.txt' }),
				reply({ content: 'hello.txt contains Hello, World!' }),
			],
			maxSteps: 8,
			isolated: true,
		});
		expect(result.reply).not.toMatch(/^\/no_think$/);
		expect(result.reply).toMatch(/Hello/i);
		expect(result.activities.some(a => a.tool === 'read')).toBe(true);
	}, 60_000);
});
