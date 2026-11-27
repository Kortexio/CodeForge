jest.mock('vscode', () => require('../support/vscodeFsMock'));

import { buildKnowledgeMarkdown, selectUsefulHits } from '../../extensions/codeforge/src/agent/knowledgePrefetch';
import type { RetrieveHit } from '../../extensions/codeforge/src/intelligence/workspaceIndex';

function hit(text: string, score: number): RetrieveHit {
	return { path: 'src/a.ts', startLine: 1, endLine: 2, text, score, source: 'lexical' };
}

describe('knowledge prefetch', () => {
	it('drops near-zero repository hits', () => {
		expect(selectUsefulHits([hit('noise', 0), hit('real', 0.4)])).toHaveLength(1);
	});

	it('puts a web search of the task in the packet when the repo has no useful hit', async () => {
		const searches: string[] = [];
		const result = await buildKnowledgeMarkdown({
			task: 'How does the Zuora invoice API page invoices?',
			enabled: true,
			retrieve: async () => [hit('unrelated', 0)],
			search: async query => {
				searches.push(query);
				return 'Web search: invoices\n1. Invoice API\n   https://example.test/invoices';
			},
		});
		expect(result.usedWeb).toBe(true);
		expect(result.repoHits).toBe(0);
		expect(result.markdown).toContain('### WEB EVIDENCE');
		expect(result.markdown).toContain('https://example.test/invoices');
		expect(searches[0]).toContain('Zuora invoice API');
	});

	it('does not call web search when repository hits are useful', async () => {
		let called = false;
		const result = await buildKnowledgeMarkdown({
			task: 'Where is the cart total?',
			enabled: true,
			retrieve: async () => [hit('function cartTotal() { return 1; }', 0.8)],
			search: async () => {
				called = true;
				return 'should not run';
			},
		});
		expect(called).toBe(false);
		expect(result.usedWeb).toBe(false);
		expect(result.markdown).toContain('### REPO EVIDENCE');
		expect(result.markdown).toContain('cartTotal');
	});
});
