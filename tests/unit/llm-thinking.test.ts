import { splitThinkContent } from '../../extensions/codeforge/src/agent/llmThinking';

describe('think-only replies', () => {
	it('keeps a leading think paragraph out of the answer so the loop can continue', () => {
		const only = splitThinkContent(
			'think: The user is asking what I can do. I should explain my capabilities.'
		);
		expect(only.content).toBe('');
		expect(only.reasoning).toContain('what I can do');

		const withAnswer = splitThinkContent('thinking: look at the tree.\n\nThe console app prints Hello.');
		expect(withAnswer.reasoning).toBe('look at the tree.');
		expect(withAnswer.content).toBe('The console app prints Hello.');
	});

	it('does not strip an answer that only mentions thinking', () => {
		const text = 'I think: the build is green.';
		expect(splitThinkContent(text).content).toBe(text);
	});
});

describe('<thought> tag replies (not just <think>)', () => {
	it('strips a bare <thought>...</thought> reply so the loop can continue', () => {
		const result = splitThinkContent(
			'<thought>\nThe user wants me to find and fix the failing tests. Let me run them first.\n</thought>'
		);
		expect(result.content).toBe('');
		expect(result.reasoning).toContain('failing tests');
	});

	it('keeps an answer that follows a <thought> block', () => {
		const result = splitThinkContent('<thought>plan it</thought>\n\nRan the tests; 2 failed.');
		expect(result.reasoning).toBe('plan it');
		expect(result.content).toBe('Ran the tests; 2 failed.');
	});
});
