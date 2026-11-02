/**
 * Detects a "phantom" tool announcement: the assistant's text says it is about to call a tool
 * (in English or Portuguese, since this harness serves both) but no tool call was actually
 * produced — neither a native `tool_calls` entry nor anything a family grammar parser
 * recovered. Weak/instruction-light models do this more than Qwen. The caller re-prompts with
 * `buildPhantomRetryPrompt`, capped by `DEFAULT_PHANTOM_RETRY_CAP` retries per turn so a model
 * that keeps announcing without calling cannot loop forever.
 */

import { foldToolToken } from '../toolCallNormalizer';

export interface PhantomToolUseInput {
	/** Assistant visible text for this turn, after any family-grammar markup has been stripped. */
	text: string;
	/** True when at least one real tool call (native or family-recovered) was produced. */
	hasToolCalls: boolean;
	toolNames: ReadonlySet<string>;
}

export interface PhantomToolUseResult {
	isPhantom: boolean;
	matchedToolName?: string;
	reason?: string;
}

// English and Portuguese announcement phrasings, each capturing the tool name that follows.
const ANNOUNCE_RES: RegExp[] = [
	/\b(?:I(?:'| wi)ll|I am going to|I'm going to|Let me)\s+(?:now\s+)?(?:call|use|invoke|run)\s+(?:the\s+)?(?:tool\s+)?["'`]?([A-Za-z0-9_][A-Za-z0-9_.:-]*)["'`]?/i,
	/\b(?:Vou|Vou agora|Irei)\s+(?:chamar|usar|invocar|executar)\s+(?:a\s+(?:ferramenta|tool)\s+)?["'`]?([A-Za-z0-9_][A-Za-z0-9_.:-]*)["'`]?/i,
	/\bcalling\s+["'`]?([A-Za-z0-9_][A-Za-z0-9_.:-]*)["'`]?\s+now\b/i,
];

export function detectPhantomToolUse(input: PhantomToolUseInput): PhantomToolUseResult {
	if (input.hasToolCalls || !input.toolNames.size) return { isPhantom: false };
	const folded = new Map<string, string>();
	for (const t of input.toolNames) folded.set(foldToolToken(t), t);

	// A weak model sometimes types the tool name by itself instead of emitting a tool call
	// (e.g. the entire completion is "update_status"). Compare against known tool names only —
	// no guess at what the user meant, just whether this text IS a tool identifier.
	const bare = input.text.trim().replace(/^[`'"*_]+|[`'"*_.!?:]+$/g, '');
	if (bare && bare.length <= 40) {
		const matched = folded.get(foldToolToken(bare));
		if (matched) {
			return { isPhantom: true, matchedToolName: matched, reason: `replied with the tool name "${bare}" instead of calling it` };
		}
	}

	for (const re of ANNOUNCE_RES) {
		const m = re.exec(input.text);
		if (!m) continue;
		const matched = folded.get(foldToolToken(m[1]));
		if (matched) {
			return { isPhantom: true, matchedToolName: matched, reason: `announced "${m[1]}" without emitting a tool call` };
		}
	}
	return { isPhantom: false };
}

export const DEFAULT_PHANTOM_RETRY_CAP = 2;

export function shouldRetryPhantomToolUse(retriesSoFar: number, cap: number = DEFAULT_PHANTOM_RETRY_CAP): boolean {
	return retriesSoFar < cap;
}

export function buildPhantomRetryPrompt(toolName: string): string {
	return (
		`You said you would call ${toolName}, but no tool call was received in the expected format. ` +
		`Call ${toolName} now using the tool-calling mechanism, or continue without it if it is no longer needed.`
	);
}
