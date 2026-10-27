/**
 * Thinking / chain-of-thought controls for OpenAI-compatible agent rounds.
 *
 * Pattern (Qwen docs, Ollama tools-default-off, OpenCode plan/build):
 * - Agent tool rounds → thinking OFF by default (faster, tool tokens emit correctly)
 * - Agent tool rounds with profile `thinking.toolRounds` → thinking ON (interleaved:
 *   reasoning of the current turn stays in history so each step builds on the last)
 * - Plan mode → thinking ON (deeper exploration)
 * - Only send enable_thinking* when the model supports it: measured by calibrate
 *   (`thinking.supported`), name heuristic only for models not calibrated yet
 */

/** Model ids that commonly default thinking ON or honor enable_thinking. */
const THINKING_MODEL_RE =
	/\b(qwen3|qwq|deepseek-?r1|r1-|bonsai|gemma-?4|gpt-?oss|hydra|ornith|thinking|reasoner)\b/i;

/** Name heuristic — fallback for models with no measured `thinking.supported`. */
export function modelLikelySupportsThinking(model: string | undefined): boolean {
	const id = String(model ?? '').trim();
	if (!id) return false;
	return THINKING_MODEL_RE.test(id);
}

export interface ThinkingRoundInput {
	model: string;
	/** ModelProfile `thinking.supported` (calibrate probe). Wins over the name heuristic. */
	thinkingSupported?: boolean;
	/** Plan mode keeps thinking ON (OpenCode-style). */
	planMode?: boolean;
	/** Native tools present on this request. */
	withTools?: boolean;
	/** Prose JSON tool protocol (still a tool-action turn). */
	proseToolsOnly?: boolean;
	/** ModelProfile `thinking.toolRounds`: reason before choosing each tool call. */
	toolRoundThinking?: boolean;
	/** One-shot escalation after a structural stumble (hybrid thinking). */
	escalatedThinking?: boolean;
}

function isToolRound(input: ThinkingRoundInput): boolean {
	return !!(input.withTools || input.proseToolsOnly);
}

export function supportsThinking(input: Pick<ThinkingRoundInput, 'model' | 'thinkingSupported'>): boolean {
	if (typeof input.thinkingSupported === 'boolean') return input.thinkingSupported;
	return modelLikelySupportsThinking(input.model);
}

/**
 * Whether we should hard-disable thinking for this round.
 * Returns false when the model has no thinking support (do not send flags).
 */
export function shouldDisableThinking(input: ThinkingRoundInput): boolean {
	if (!supportsThinking(input)) return false;
	if (input.planMode || input.toolRoundThinking || input.escalatedThinking) return false;
	return isToolRound(input);
}

/** Whether we should hard-enable thinking (Plan, always-on tool rounds, or escalated). */
export function shouldEnableThinking(input: ThinkingRoundInput): boolean {
	if (!supportsThinking(input)) return false;
	if (input.planMode) return true;
	if (input.escalatedThinking && isToolRound(input)) return true;
	return !!input.toolRoundThinking && isToolRound(input);
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
	toolReasoning?: { temperature: number; top_p: number; presence_penalty: number };
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
	if (input.planMode && shouldEnableThinking(input)) {
		return { temperature: samp.plan.temperature, top_p: samp.plan.top_p };
	}
	if (shouldEnableThinking(input)) {
		// Tool rounds with thinking: own slice, so enabling thinking does not also widen sampling.
		const s = samp.toolReasoning ?? samp.toolThinking;
		return { temperature: s.temperature, top_p: s.top_p, presence_penalty: s.presence_penalty };
	}
	if (shouldDisableThinking(input) || supportsThinking(input)) {
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
	limits?: { mutatingMaxTokens: number; readOnlyMaxTokens: number; thinkingMaxTokens?: number }
): number {
	if (!isToolRound(input)) return completionCap;
	if (input.planMode) return completionCap;
	// Reasoning comes before the call, so the read/write caps would starve it.
	if (shouldEnableThinking(input)) {
		const cap = limits?.thinkingMaxTokens;
		return typeof cap === 'number' && cap > 0 ? Math.min(completionCap, cap) : completionCap;
	}
	if (!shouldDisableThinking(input) && !supportsThinking(input)) {
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

function reasoningText(m: MsgLike): string {
	for (const v of [m.reasoning_content, m.reasoning, m.thinking]) {
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return '';
}

/**
 * Drop CoT fields and `<think>` blocks so later rounds stay lean.
 * `keepCurrentTurn`: assistant messages after the last user message keep their reasoning as
 * `reasoning_content` (interleaved thinking across the tool steps of one turn). Older turns are
 * always stripped, which matches what Qwen3-style chat templates render.
 */
export function stripReasoningFromMessages<T extends MsgLike>(
	messages: T[],
	opts: { keepCurrentTurn?: boolean } = {}
): T[] {
	let lastUser = -1;
	if (opts.keepCurrentTurn) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') {
				lastUser = i;
				break;
			}
		}
	}
	return messages.map((m, i) => {
		const next: MsgLike = { ...m };
		const kept = opts.keepCurrentTurn && i > lastUser && m.role === 'assistant' ? reasoningText(m) : '';
		delete next.reasoning;
		delete next.reasoning_content;
		delete next.thinking;
		if (typeof next.content === 'string') {
			next.content = stripThinkBlocks(next.content);
		}
		if (kept) next.reasoning_content = kept;
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

/** Chat-completions body that asks for thinking on a tool round (calibrate support probe). */
export function thinkingProbeRequest(model: string): Record<string, unknown> {
	return {
		model,
		temperature: 0.6,
		top_p: 0.95,
		max_tokens: 1024,
		stream: false,
		tools: [
			{
				type: 'function',
				function: {
					name: 'read',
					description: 'Read a file',
					parameters: {
						type: 'object',
						properties: { path: { type: 'string' } },
						required: ['path'],
					},
				},
			},
		],
		tool_choice: 'auto',
		messages: applySoftThinkSwitch(
			[
				{ role: 'system', content: 'You are a coding agent. Use the read tool to inspect files.' },
				{
					role: 'user',
					content: 'Coupons expire one day early. The logic is in src/pricing/coupons.js. Find the cause.',
				},
			],
			false
		),
		enable_thinking: true,
		chat_template_kwargs: { enable_thinking: true },
	};
}

/**
 * Whether a probe response shows separate reasoning together with a usable answer.
 * Reasoning alone (no tool call, no content) does not count: the round would be wasted.
 */
export function thinkingProbeObserved(message: unknown): boolean {
	if (!message || typeof message !== 'object') return false;
	const m = message as MsgLike;
	const raw = typeof m.content === 'string' ? m.content : '';
	const split = splitThinkContent(raw);
	const reasoning = reasoningText(m) || split.reasoning;
	const answered = (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || !!split.content;
	return !!reasoning && answered;
}
