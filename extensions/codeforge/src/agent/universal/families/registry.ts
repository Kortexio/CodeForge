/**
 * Orchestrates the per-family grammar parsers: picks which families to try (from the caller's
 * `ModelFamilyProfile.grammars`, Fase 1's `modelFamily.ts` — not a dependency of this file, the
 * caller resolves the profile and passes the family id list in), applies the shared safety
 * gates each parser already implements (`families/safety.ts`: code-fence masking, known-tool
 * filtering), searches an optional `reasoning_content` side channel (Kimi/DeepSeek-R1 are known
 * to leak markup there), and never promotes anything when the provider already sent native
 * `tool_calls` for this turn (pi-tool-repair's "don't duplicate" gate).
 */

import { dedupeIdenticalToolCalls } from '../../xmlToolCalls';
import { deepseekR1Parser } from './deepseekR1';
import { dsmlParser } from './dsml';
import { gemma4Parser } from './gemma4';
import { glmParser } from './glm';
import { graniteParser } from './granite';
import { harmonyParser } from './harmony';
import { kimiParser } from './kimi';
import { llamaParser } from './llama';
import { minimaxParser } from './minimax';
import { minimaxTextParser } from './minimaxText';
import { mistralParser } from './mistral';
import { olmoParser } from './olmo';
import { phi4Parser } from './phi4';
import { qwenParser } from './qwen';
import type { FamilyRepairEvent, GrammarParser, LiftedToolCall } from './types';

/** Every known family parser, in no particular priority order (callers pick a subset by id). */
export const ALL_GRAMMAR_PARSERS: GrammarParser[] = [
	qwenParser,
	deepseekR1Parser,
	dsmlParser,
	gemma4Parser,
	harmonyParser,
	mistralParser,
	llamaParser,
	kimiParser,
	glmParser,
	graniteParser,
	minimaxParser,
	minimaxTextParser,
	olmoParser,
	phi4Parser,
];

const PARSERS_BY_ID = new Map(ALL_GRAMMAR_PARSERS.map((p) => [p.id, p]));

export interface RecoverToolCallsInput {
	/** Assistant visible-text content for this turn. */
	text: string;
	/** `reasoning_content` / `reasoning` side channel, when the provider sends one separately. */
	reasoningText?: string;
	/** Tool names actually offered this turn; empty/absent disables the known-tool filter. */
	toolNames: ReadonlySet<string>;
	/** True when the provider already returned native `tool_calls` for this turn. */
	hasNativeToolCalls: boolean;
	/** Family ids to try, in priority order (from `ModelFamilyProfile.grammars`). */
	families: readonly string[];
	/** `recover` promotes matches to real tool_calls; `strip` only removes the markup. */
	mode?: 'recover' | 'strip';
}

export interface RecoverToolCallsResult {
	calls: LiftedToolCall[];
	cleanedText: string;
	cleanedReasoningText: string | undefined;
	events: FamilyRepairEvent[];
}

export function recoverToolCalls(input: RecoverToolCallsInput): RecoverToolCallsResult {
	const mode = input.mode ?? 'recover';

	// pi-tool-repair's primary safety gate: never run grammar recovery when the provider
	// already sent native tool_calls for this turn, to avoid duplicating/conflicting calls.
	if (input.hasNativeToolCalls) {
		return { calls: [], cleanedText: input.text, cleanedReasoningText: input.reasoningText, events: [] };
	}

	const ctx = { toolNames: input.toolNames };
	const events: FamilyRepairEvent[] = [];
	let calls: LiftedToolCall[] = [];
	let cleanedText = input.text;
	let reasoningText = input.reasoningText;

	for (const id of input.families) {
		const parser = PARSERS_BY_ID.get(id);
		if (!parser) continue;

		const matchesText = parser.detect(cleanedText);
		const matchesReasoning = !!reasoningText && parser.detect(reasoningText);
		if (!matchesText && !matchesReasoning) continue;

		let found: LiftedToolCall[] = [];

		if (matchesText) {
			const result = parser.parse(cleanedText, ctx);
			if (result.calls.length) {
				found = found.concat(result.calls);
				cleanedText = result.cleanedText;
			}
		}
		if (matchesReasoning && reasoningText) {
			const result = parser.parse(reasoningText, ctx);
			if (result.calls.length) {
				found = found.concat(result.calls);
				reasoningText = result.cleanedText;
			}
		}

		if (!found.length) continue;

		events.push({ family: id, mode, recoveredCalls: mode === 'recover' ? found.length : 0, fromReasoning: matchesReasoning && !matchesText });
		if (mode === 'recover') calls = calls.concat(found);

		// Grammars are mutually exclusive per turn in practice — once one family matches and
		// is handled, stop trying the rest against the (now cleaned) text.
		break;
	}

	return { calls: dedupeIdenticalToolCalls(calls), cleanedText, cleanedReasoningText: reasoningText, events };
}
