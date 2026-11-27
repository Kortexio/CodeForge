/**
 * Multi-round prose: text from a round that ended in a tool call must stay visible
 * while the next round streams, instead of being replaced.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import type { ScriptedStep } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

describe('agent streaming across tool rounds', () => {
	const router: ScriptedStep = body => {
		const hasToolResult = (body.messages ?? []).some(
			m => (m as { role?: string })?.role === 'tool'
		);
		return hasToolResult
			? { content: 'It declares x.', streamPieces: ['It ', 'declares x.'] }
			: {
					content: 'Reading the file first.',
					tool_calls: [{ name: 'read', arguments: { path: 'a.ts' } }],
				};
	};

	it('keeps earlier prose above the streamed text of the next round', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Read a.ts and summarize.',
			script: [
				// Router: first call plans + reads, any later call (tool result present) summarizes.
				router,
				router,
				router,
			],
			maxSteps: 6,
			weakProfile: false,
		});
		const combined = result.streamed.find(
			t => t.includes('Reading the file first.') && t.includes('It declares x.')
		);
		expect(combined).toBeTruthy();
		expect(combined!.indexOf('Reading the file first.')).toBeLessThan(
			combined!.indexOf('It declares x.')
		);
	}, 60_000);
});
