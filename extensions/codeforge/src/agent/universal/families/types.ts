/**
 * Grammar parsers recover leaked tool-call markup (XML/sentinel tokens a model wrote as
 * plain text instead of a native `tool_calls` entry) back into structured calls.
 * One parser per model family. See PARITY.md for the pi-tool-repair survey this is based on.
 */

import type { LiftedToolCall } from '../../xmlToolCalls';

export type { LiftedToolCall };

export interface GrammarParseContext {
	/** Tool names the caller actually sent this turn. Empty/absent = no name filter. */
	toolNames: ReadonlySet<string>;
}

export interface GrammarParseResult {
	calls: LiftedToolCall[];
	/** Text with recovered/leaked markup removed (visible-text hygiene, independent of recover vs strip). */
	cleanedText: string;
}

export interface GrammarParser {
	/** Stable id, matches the `grammars` list in a `ModelFamilyProfile` and `RepairEvent.family`. */
	id: string;
	/** Cheap textual check before running the full parse (avoids running every regex on every turn). */
	detect(text: string): boolean;
	/** Parse leaked markup into calls and return the text with that markup removed. */
	parse(text: string, ctx: GrammarParseContext): GrammarParseResult;
}

/**
 * One grammar-recovery outcome for a single assistant turn, meant to be folded into the
 * harness's telemetry stream by `repairEvent.ts` (Fase 1, not yet wired here).
 */
export interface FamilyRepairEvent {
	family: string;
	mode: 'recover' | 'strip';
	/** Number of calls promoted to real tool_calls (0 in `strip` mode, or when nothing matched). */
	recoveredCalls: number;
	/** True when the leaked markup was found in a `reasoning_content`-style side channel. */
	fromReasoning: boolean;
}
