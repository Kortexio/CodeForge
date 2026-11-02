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

	// Regression: an attached image disappeared before the model ever saw it. The
	// token estimate JSON-stringified the base64 payload, so a single image pushed
	// the turn over the hard-compact threshold on step 1, and compaction rebuilt the
	// user message as plain text. The vision model then answered "image not visible".
	it('sends the attached image to the model on the first request of an image turn', async () => {
		const dataUrl = `data:image/png;base64,${'A'.repeat(200_000)}`;
		const result = await runLoop({
			files: { 'README.md': '# fixture\n' },
			task: 'What is in this image? Answer in one word.',
			images: [{ mime: 'image/png', dataUrl, label: 'image.png' }],
			askMode: true,
			script: [reply({ content: 'Red' })],
			maxSteps: 8,
			isolated: true,
		});
		const first = result.requests[0]?.body.messages as Array<{ content: unknown }> | undefined;
		const userTurn = first?.[first.length - 1];
		expect(Array.isArray(userTurn?.content)).toBe(true);
		const imageParts = (userTurn?.content as Array<{ type: string; image_url?: { url: string } }>).filter(
			p => p.type === 'image_url'
		);
		expect(imageParts.map(p => p.image_url?.url)).toEqual([dataUrl]);
	}, 60_000);

	// Regression: when a hard compaction does run mid-turn, the rebuilt user message
	// must still carry the current turn's image — compaction summarizes text, it
	// must not drop what the user is asking about.
	it('keeps the attached image after a hard compaction rebuilds the turn', async () => {
		const dataUrl = `data:image/png;base64,${'B'.repeat(1_000)}`;
		const result = await runLoop({
			files: { 'README.md': '# fixture\n' },
			// Long text task forces the hard-compact threshold on step 1 regardless of the image.
			task: `Describe the attached picture. ${'context line. '.repeat(12_000)}`,
			images: [{ mime: 'image/png', dataUrl, label: 'image.png' }],
			askMode: true,
			script: [
				// Step 1 is the compaction summary call (no tools), step 2 the real round.
				reply({ content: '## Objective\n- Describe the picture.\n## Next Move\n1. Look at it.' }),
				reply({ content: 'Red square' }),
			],
			maxSteps: 8,
			isolated: true,
		});
		const mainRound = result.requests.find(r =>
			(r.body.messages as Array<{ content: unknown }> | undefined)?.some(
				m => Array.isArray(m.content) && m.content.some(p => (p as { type?: string }).type === 'image_url')
			)
		);
		expect(mainRound).toBeDefined();
		const imageUrls = (mainRound!.body.messages as Array<{ content: unknown }>)
			.flatMap(m => (Array.isArray(m.content) ? m.content : []))
			.filter(p => (p as { type?: string }).type === 'image_url')
			.map(p => (p as { image_url: { url: string } }).image_url.url);
		expect(imageUrls).toEqual([dataUrl]);
	}, 60_000);
});
