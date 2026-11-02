/**
 * The prompt-size estimate that drives compaction must not scale with an image's
 * base64 length — otherwise one attachment forces a hard compaction on step 1.
 */
jest.mock('vscode', () => require('../../support/vscodeFsMock'));

import { estimateTokens } from '../../../extensions/codeforge/src/agent/agentLoop';

describe('estimateTokens with image parts', () => {
	const textOnly = [{ role: 'user' as const, content: 'describe this picture' }];

	it('counts an image as a fixed token cost, not by its base64 length', () => {
		const small = [
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: 'describe this picture' },
					{ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${'A'.repeat(1_000)}` } },
				],
			},
		];
		const huge = [
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: 'describe this picture' },
					{ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${'A'.repeat(5_000_000)}` } },
				],
			},
		];
		expect(estimateTokens(huge)).toBe(estimateTokens(small));
	});

	it('adds roughly one image token budget per image on top of the text', () => {
		const withImage = [
			{
				role: 'user' as const,
				content: [
					{ type: 'text' as const, text: 'describe this picture' },
					{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } },
				],
			},
		];
		const extra = estimateTokens(withImage) - estimateTokens(textOnly);
		expect(extra).toBeGreaterThanOrEqual(1000);
		expect(extra).toBeLessThanOrEqual(1100);
	});

	it('still grows with plain text, so compaction still fires on long conversations', () => {
		const long = [{ role: 'user' as const, content: 'x'.repeat(40_000) }];
		expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(textOnly) * 100);
	});
});
