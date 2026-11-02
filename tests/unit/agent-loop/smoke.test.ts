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

	it('replying with just the tool name is retried, not shown to the user as the answer', async () => {
		const result = await runLoop({
			files: { 'hello.txt': 'Hello, World!\n' },
			task: 'e então?',
			askMode: true,
			script: [
				reply({ content: 'update_status' }),
				reply({ content: 'I can read, search and answer questions about this workspace.' }),
			],
			maxSteps: 8,
			isolated: true,
		});
		expect(result.reply).not.toBe('update_status');
		expect(result.reply).toMatch(/read, search/i);
		expect(result.activities.some(a => a.label?.includes('without calling it'))).toBe(true);
	}, 60_000);

	it('strips a think-only reply stored from before the fix out of the history it replays', async () => {
		const result = await runLoop({
			files: { 'hello.txt': 'Hello, World!\n' },
			task: 'e então?',
			askMode: true,
			history: [
				{ role: 'user', content: 'pode criar um agente para gmail?' },
				{
					role: 'assistant',
					content:
						'think: The user is asking for Gmail automation. I should explain the security risk instead.',
				},
			],
			script: [reply({ content: 'I can read and search this workspace, but not Gmail.' })],
			maxSteps: 8,
			isolated: true,
		});
		const firstRequestMessages = JSON.stringify(result.requests[0]?.body.messages ?? []);
		expect(firstRequestMessages).not.toMatch(/think: The user is asking for Gmail/);
		expect(firstRequestMessages).toMatch(/no answer was given for this turn/);
	}, 60_000);
});
