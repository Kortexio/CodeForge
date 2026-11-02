/**
 * Static, versioned per-model-family profiles (no learning/adaptation — see `PARITY.md`).
 * A model that matches no profile gets no grammar parsers and no thinking-field translation,
 * only the existing generic normalizer (`toolCallNormalizer.ts`) and `schemaRepair.ts`.
 */

import defaultsJson from './defaults.json';

export type ThinkingFormat = 'qwen' | 'openai' | 'deepseek' | 'chat-template' | 'none';

export interface SamplingDefaults {
	temperature?: number;
	topP?: number;
	topK?: number;
	presencePenalty?: number;
}

export interface ModelFamilyProfile {
	id: string;
	/** Lowercased substrings tested against the model id/name; any match selects this profile. */
	match: string[];
	/** Family-grammar parser ids to try, in order (see `families/registry.ts`). */
	grammars: string[];
	/** `recover` promotes matches to real tool_calls; `strip` only removes the leaked markup. */
	mode: 'recover' | 'strip';
	/** Also search a `reasoning_content`/`reasoning` side channel for leaked markup. */
	searchReasoning: boolean;
	thinkingFormat: ThinkingFormat;
	toolCallIdFormat?: 'kimi' | 'mistral9';
	/** Apply `^…$` anchor-bleed stripping in `requestPrep`/`schemaRepair` for this family. */
	anchorBleed?: boolean;
	/** Prefer a non-streamed request when the provider's streaming tool-call parser is fragile. */
	preferNonStreamTools?: boolean;
	sampling?: SamplingDefaults;
}

interface DefaultsFile {
	profiles: ModelFamilyProfile[];
}

export const DEFAULT_MODEL_FAMILY_PROFILES: readonly ModelFamilyProfile[] = (defaultsJson as DefaultsFile).profiles;

export function matchesProfile(modelId: string, profile: ModelFamilyProfile): boolean {
	const id = modelId.toLowerCase();
	return profile.match.some((p) => id.includes(p.toLowerCase()));
}

export interface ResolveModelFamilyInput {
	modelId: string;
	/** Explicit override from tenancy config (`CatalogModel.family`) — short-circuits substring matching. */
	explicitFamily?: string;
	/** Explicit `thinkingFormat` override from tenancy config, layered on top of the resolved profile. */
	explicitThinkingFormat?: ThinkingFormat;
	profiles?: readonly ModelFamilyProfile[];
}

/** Returns `undefined` when nothing matches — the no-profile case is a valid, expected outcome. */
export function resolveModelFamilyProfile(input: ResolveModelFamilyInput): ModelFamilyProfile | undefined {
	const profiles = input.profiles ?? DEFAULT_MODEL_FAMILY_PROFILES;
	let base: ModelFamilyProfile | undefined;
	if (input.explicitFamily) {
		base = profiles.find((p) => p.id === input.explicitFamily);
	}
	if (!base) {
		base = profiles.find((p) => matchesProfile(input.modelId, p));
	}
	if (!base) return undefined;
	if (input.explicitThinkingFormat && input.explicitThinkingFormat !== base.thinkingFormat) {
		return { ...base, thinkingFormat: input.explicitThinkingFormat };
	}
	return base;
}
