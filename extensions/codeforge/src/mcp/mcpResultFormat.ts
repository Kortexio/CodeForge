import { clipData } from '../agent/clip';

export const MCP_RESULT_MAX_CHARS = 24_000;

export function formatMcpResult(result: unknown, maxChars = MCP_RESULT_MAX_CHARS): string {
	if (result == null) return '(empty)';
	const r = result as {
		isError?: boolean;
		content?: Array<{ type?: string; text?: string; isError?: boolean }>;
	};
	let text: string;
	if (typeof result === 'string') {
		text = result;
	} else if (Array.isArray(r.content)) {
		text = r.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
	} else {
		text = JSON.stringify(result, null, 2);
	}
	const itemError =
		r.isError === true || r.content?.some(c => c.isError === true || c.type === 'error');
	if (itemError && !/^error:/i.test(text.trim())) {
		text = `Error: ${text}`;
	}
	return clipData(text, maxChars);
}
