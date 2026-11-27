/**
 * Settled reply must keep prose streamed in earlier tool rounds — otherwise the bubble
 * visibly shrinks the moment the turn finishes.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import type { ScriptedStep } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

describe('settled reply keeps earlier-round prose', () => {
	const router: ScriptedStep = body => {
		const hasToolResult = (body.messages ?? []).some(
			m => (m as { role?: string })?.role === 'tool'
		);
		return hasToolResult
			? { content: 'It declares x.' }
			: {
					content: 'Reading the file first.',
					tool_calls: [{ name: 'read', arguments: { path: 'a.ts' } }],
				};
	};

	it('keeps both the planning sentence and the final summary', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Read a.ts and summarize.',
			script: [router, router, router],
			maxSteps: 6,
			weakProfile: false,
		});
		expect(result.reply).toContain('Reading the file first.');
		expect(result.reply).toContain('It declares x.');
		expect(result.reply.indexOf('Reading the file first.')).toBeLessThan(
			result.reply.indexOf('It declares x.')
		);
	}, 60_000);
});
