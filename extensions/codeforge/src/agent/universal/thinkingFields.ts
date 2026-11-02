/**
 * Format-aware translation of the enable/disable-thinking decision into provider-specific
 * request fields. `llmThinking.ts`'s `shouldEnableThinking`/`shouldDisableThinking` (unchanged)
 * still decide *whether* to think for this round; this module only decides *how to say so* on
 * the wire, per `ModelFamilyProfile.thinkingFormat`.
 *
 * When `format` is `undefined` (model matched no `ModelFamilyProfile`), this falls back to the
 * original Qwen-shaped `llmThinkingRequestFields` so unprofiled models keep today's behavior —
 * `THINKING_MODEL_RE` stays alive purely as that fallback's name heuristic, per the plan.
 */

import { llmThinkingRequestFields, shouldDisableThinking, shouldEnableThinking, type ThinkingRoundInput } from '../llmThinking';
import type { ThinkingFormat } from './modelFamily';

export function thinkingFields(format: ThinkingFormat | undefined, input: ThinkingRoundInput): Record<string, unknown> {
	if (!format) return llmThinkingRequestFields(input);

	const enable = shouldEnableThinking(input);
	const disable = shouldDisableThinking(input);
	if (!enable && !disable) return {};

	switch (format) {
		case 'qwen':
			return { enable_thinking: enable, chat_template_kwargs: { enable_thinking: enable } };
		case 'chat-template':
			return { chat_template_kwargs: { enable_thinking: enable } };
		case 'deepseek':
			return { thinking: { type: enable ? 'enabled' : 'disabled' } };
		case 'openai':
			// No broadly-supported explicit "off" value for reasoning_effort — omit the field
			// rather than send a guess that some gateways reject.
			return enable ? { reasoning_effort: 'medium' } : {};
		case 'none':
		default:
			return {};
	}
}
