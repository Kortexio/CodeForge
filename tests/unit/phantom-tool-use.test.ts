import { detectPhantomToolUse, buildPhantomRetryPrompt } from '../../extensions/codeforge/src/agent/universal/phantomToolUse';

const toolNames = new Set(['update_status', 'write', 'shell', 'think']);

describe('phantom tool use: bare tool name', () => {
	it('flags a reply that is only a known tool name, not a real answer', () => {
		const result = detectPhantomToolUse({ text: 'update_status', hasToolCalls: false, toolNames });
		expect(result.isPhantom).toBe(true);
		expect(result.matchedToolName).toBe('update_status');
		expect(buildPhantomRetryPrompt(result.matchedToolName!)).toContain('update_status');
	});

	it('still catches it through surrounding punctuation and backticks', () => {
		expect(detectPhantomToolUse({ text: '`update_status`', hasToolCalls: false, toolNames }).isPhantom).toBe(true);
		expect(detectPhantomToolUse({ text: 'update_status.', hasToolCalls: false, toolNames }).isPhantom).toBe(true);
	});

	it('does not flag a real answer that happens to be short', () => {
		expect(detectPhantomToolUse({ text: 'Done.', hasToolCalls: false, toolNames }).isPhantom).toBe(false);
		expect(detectPhantomToolUse({ text: 'I updated the status for you.', hasToolCalls: false, toolNames }).isPhantom).toBe(false);
	});

	it('does not flag anything once a real tool call was made', () => {
		expect(detectPhantomToolUse({ text: 'update_status', hasToolCalls: true, toolNames }).isPhantom).toBe(false);
	});

	it('still catches an announced-but-not-called tool (regression for the existing detector)', () => {
		const result = detectPhantomToolUse({ text: "I'll call update_status now.", hasToolCalls: false, toolNames });
		expect(result.isPhantom).toBe(true);
		expect(result.matchedToolName).toBe('update_status');
	});
});
