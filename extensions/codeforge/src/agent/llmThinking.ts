/**
 * Thinking / chain-of-thought controls for OpenAI-compatible agent rounds.
 *
 * Pattern (Qwen docs, Ollama tools-default-off, OpenCode plan/build):
 * - Agent tool rounds → thinking OFF (faster, tool tokens emit correctly)
 * - Plan mode → thinking ON (deeper exploration)
 * - Only send enable_thinking* when the model likely supports it
 */

/** Model ids that commonly default thinking ON or honor enable_thinking. */
const THINKING_MODEL_RE =
	/\b(qwen3|qwq|deepseek-?r1|r1-|bonsai|gemma-?4|gpt-?oss|hydra|ornith|thinking|reasoner)\b/i;

export function modelLikelySupportsThinking(model: string | undefined): boolean {
	const id = String(model ?? '').trim();
	if (!id) return false;
	return THINKING_MODEL_RE.test(id);
}

export interface ThinkingRoundInput {
	model: string;
	/** Plan mode keeps thinking ON (OpenCode-style). */
	planMode?: boolean;
	/** Native tools present on this request. */
	withTools?: boolean;
	/** Prose JSON tool protocol (still a tool-action turn). */
	proseToolsOnly?: boolean;
}

/**
 * Whether we should hard-disable thinking for this round.
 * Returns false when the model has no thinking support (do not send flags).
 */
export function shouldDisableThinking(input: ThinkingRoundInput): boolean {
	if (!modelLikelySupportsThinking(input.model)) return false;
	if (input.planMode) return false;
	return !!(input.withTools || input.proseToolsOnly);
}

/** Whether we should hard-enable thinking (Plan on reasoning models). */
export function shouldEnableThinking(input: ThinkingRoundInput): boolean {
	if (!modelLikelySupportsThinking(input.model)) return false;
	return !!input.planMode;
}

/**
 * Request body fields for thinking. Empty when the model is not a thinker
 * (avoids 400s on gateways that reject unknown params).
 */
export function llmThinkingRequestFields(input: ThinkingRoundInput): Record<string, unknown> {
	if (shouldDisableThinking(input)) {
		return {
			enable_thinking: false,
			chat_template_kwargs: { enable_thinking: false },
		};
	}
	if (shouldEnableThinking(input)) {
		return {
			enable_thinking: true,
			chat_template_kwargs: { enable_thinking: true },
		};
	}
	return {};
}

export type SamplingProfileSlice = {
	plan: { temperature: number; top_p: number };
	toolThinking: { temperature: number; top_p: number; presence_penalty: number };
	plain: { temperature: number; top_p: number };
};

/** Sampling aligned with Qwen non-thinking vs thinking recommendations (or ModelProfile). */
export function llmSamplingOptions(
	input: ThinkingRoundInput,
	profile?: SamplingProfileSlice
): {
	temperature: number;
	top_p: number;
	presence_penalty?: number;
} {
	const samp = profile ?? {
		plan: { temperature: 0.6, top_p: 0.95 },
		toolThinking: { temperature: 0.7, top_p: 0.8, presence_penalty: 0 },
		plain: { temperature: 0.2, top_p: 1 },
	};
	if (shouldEnableThinking(input)) {
		return { temperature: samp.plan.temperature, top_p: samp.plan.top_p };
	}
	if (shouldDisableThinking(input) || modelLikelySupportsThinking(input.model)) {
		// Non-thinking / tool rounds. presence_penalty stays 0 by default: tool calls must
		// repeat tokens (</parameter>, old_string copied into new_string).
		return {
			temperature: samp.toolThinking.temperature,
			top_p: samp.toolThinking.top_p,
			presence_penalty: samp.toolThinking.presence_penalty,
		};
	}
	return { temperature: samp.plain.temperature, top_p: samp.plain.top_p };
}

/**
 * Cap completion tokens for tool rounds (less room for accidental CoT).
 * Mutating tools keep more budget for large write/edit argument payloads.
 */
export function toolAwareMaxTokens(
	completionCap: number,
	input: ThinkingRoundInput & { tools?: Array<{ function?: { name?: string } }> },
	limits?: { mutatingMaxTokens: number; readOnlyMaxTokens: number }
): number {
	if (!input.withTools && !input.proseToolsOnly) return completionCap;
	// Plan keeps thinking ON — do not starve the completion budget.
	if (input.planMode) return completionCap;
	if (!shouldDisableThinking(input) && !modelLikelySupportsThinking(input.model)) {
		return completionCap;
	}
	const mutating = limits?.mutatingMaxTokens ?? 6144;
	const readOnly = limits?.readOnlyMaxTokens ?? 3072;
	const names = (input.tools ?? []).map(t => t.function?.name ?? '');
	const mutates = names.some(n =>
		/^(write|edit|apply_patch|notebook_edit|search_replace)$/i.test(n)
	);
	if (mutates) return Math.min(completionCap, mutating);
	// Parallel tool rounds need room for several argument payloads.
	return Math.min(completionCap, readOnly);
}

const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const CHANNEL_THINK_RE =
	/<\|channel\|>analysis<\|message\|>[\s\S]*?(?=<\|start\|>assistant<\|channel\|>final<\|message\|>|$)/gi;
/** Lines that only echo the soft switch the harness appends to user turns. */
const SOFT_SWITCH_LINE_RE = /^[ \t]*\/(?:no_)?think[ \t]*$/gim;

/** Pull visible CoT out of assistant text for the UI; strip before history. */
export function splitThinkContent(raw: string): { content: string; reasoning: string } {
	const text = String(raw ?? '');
	if (!text) return { content: '', reasoning: '' };
	const parts: string[] = [];
	let without = text.replace(THINK_BLOCK_RE, m => {
		const inner = m.replace(/^<think\b[^>]*>/i, '').replace(/<\/think>$/i, '');
		if (inner.trim()) parts.push(inner.trim());
		return '';
	});
	without = without.replace(CHANNEL_THINK_RE, m => {
		const inner = m
			.replace(/^<\|channel\|>analysis<\|message\|>/i, '')
			.replace(/<\|start\|>assistant<\|channel\|>final<\|message\|>$/i, '');
		if (inner.trim()) parts.push(inner.trim());
		return '';
	});
	without = without.replace(SOFT_SWITCH_LINE_RE, '');
	return {
		content: without.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n'),
		reasoning: parts.join('\n\n').trim(),
	};
}

export function stripThinkBlocks(raw: string): string {
	return splitThinkContent(raw).content;
}

type MsgLike = {
	role: string;
	content?: unknown;
	tool_calls?: unknown;
	tool_call_id?: unknown;
	name?: unknown;
	reasoning?: unknown;
	reasoning_content?: unknown;
	thinking?: unknown;
};

/** Drop CoT fields and `<think>` blocks so later rounds stay lean. */
export function stripReasoningFromMessages<T extends MsgLike>(messages: T[]): T[] {
	return messages.map(m => {
		const next: MsgLike = { ...m };
		delete next.reasoning;
		delete next.reasoning_content;
		delete next.thinking;
		if (typeof next.content === 'string') {
			next.content = stripThinkBlocks(next.content);
		}
		return next as T;
	});
}

/**
 * Soft switch for Qwen3 multi-turn: most recent `/no_think` or `/think` wins.
 * Appended to the last user message (Qwen docs) for the outbound request only.
 */
export function applySoftThinkSwitch<T extends MsgLike>(
	messages: T[],
	disableThinking: boolean
): T[] {
	if (!messages.length) return messages;
	const tag = disableThinking ? '/no_think' : '/think';
	const opposite = disableThinking ? '/think' : '/no_think';
	const out = messages.map(m => ({ ...m }));
	let idx = -1;
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i].role === 'user' && typeof out[i].content === 'string') {
			idx = i;
			break;
		}
	}
	if (idx < 0) {
		out.push({ role: 'user', content: tag } as T);
		return out;
	}
	const body = String(out[idx].content);
	if (body.includes(tag)) return out;
	const cleaned = body.replace(new RegExp(`(?:\\s|\\n)*${opposite}\\s*$`), '').trimEnd();
	out[idx] = { ...out[idx], content: `${cleaned}\n${tag}` } as T;
	return out;
}
