/**
 * Prose Tool Call Parser Tests
 */

import { ProseToolCallParser } from '../../../src/ai/models/prose-parser';

describe('ProseToolCallParser', () => {
    let parser: ProseToolCallParser;

    beforeEach(() => {
        parser = new ProseToolCallParser();
    });

    it('parses XML tool_call format', () => {
        const content = `I'll read the file.
<tool_call>
{"name": "read", "arguments": {"path": "src/index.ts"}}
</tool_call>`;

        const calls = parser.parse(content);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('read');
        expect(calls[0].arguments).toEqual({ path: 'src/index.ts' });
    });

    it('parses JSON code block format', () => {
        const content = `Using tool:
\`\`\`json
{"name": "shell", "arguments": {"command": "npm test"}}
\`\`\``;

        const calls = parser.parse(content);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('shell');
        expect(calls[0].arguments).toEqual({ command: 'npm test' });
    });

    it('returns empty array when no tool calls', () => {
        const calls = parser.parse('Just a normal response without tools.');
        expect(calls).toHaveLength(0);
    });

    it('deduplicates identical tool calls', () => {
        const content = `
<tool_call>
{"name": "read", "arguments": {"path": "a.ts"}}
</tool_call>
<tool_call>
{"name": "read", "arguments": {"path": "a.ts"}}
</tool_call>`;

        const calls = parser.parse(content);
        expect(calls).toHaveLength(1);
    });
});
