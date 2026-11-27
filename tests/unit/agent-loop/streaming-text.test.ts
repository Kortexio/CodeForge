/**
 * Streaming UI: the loop must hand assistant prose to the pending bubble as it arrives,
 * not only after the turn settles.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { reply } from './support/scriptedModel';
import { runLoop } from './support/runLoop';

describe('agent streaming text', () => {
	it('reports growing prose to the UI before the turn finishes', async () => {
		const result = await runLoop({
			files: { 'a.ts': 'const x = 1;\n' },
			task: 'Summarize a.ts.',
			script: [
				reply({
					content: 'The file declares one constant.',
					streamPieces: ['The file ', 'declares ', 'one constant.'],
				}),
			],
			maxSteps: 4,
		});
		expect(result.streamed.length).toBeGreaterThan(0);
		const last = result.streamed[result.streamed.length - 1] ?? '';
		expect(last).toContain('one constant.');
		// Each report is a full prefix, so the bubble can replace its body safely.
		for (const text of result.streamed) {
			expect('The file declares one constant.'.startsWith(text)).toBe(true);
		}
		expect(result.reply).toContain('one constant.');
	}, 60_000);
});
