/**
 * Generic-first context-window resolution: `contextWindowFromModelsList` (in `llamaSlots.ts`)
 * already reads provider-agnostic `/models` fields (`meta.n_ctx`, `context_length`,
 * `max_model_len`, `max_context_length`) with no llama.cpp-specific logic — that part of the
 * plan's "generic contextWindow.ts" was already satisfied. This module is the single entry
 * point that tries the generic `/models` fields first and only falls back to llama.cpp's
 * `/slots` probe (self-hosted-only, gated by `shouldProbeLlamaSlots`) when the generic lookup
 * comes back empty, so callers (the Fase 2 health check, the harness context budget) do not
 * need to know about the llama.cpp-specific path at all for non-llama.cpp providers.
 */

// Note: `contextWindowFromModelsList`, `effectiveContextBudget` and `shouldProbeLlamaSlots` are
// already exported at the package root via `export * from './llamaSlots'` — not re-exported
// again here, to avoid a duplicate-export collision at `packages/agent-harness/src/index.ts`.
import {
	contextWindowFromModelsList,
	effectiveContextBudget,
	parseLlamaSlots,
	parseModelStatusArgs,
	shouldProbeLlamaSlots,
	type LlamaSlotCaps,
} from '../llamaSlots';

export interface ResolveContextWindowInput {
	baseUrl: string;
	modelId: string;
	/** Response body of `GET /models` (or `/v1/models`), when available. */
	modelsListBody?: unknown;
	/** Response body of `GET /slots`, when the caller already probed it. */
	slotsBody?: unknown;
	/** Response body of a router's model-status endpoint, as a last-resort fallback. */
	modelStatusBody?: unknown;
	/** Caller-configured context budget, used when nothing else reports a window. */
	configured?: number;
}

export type ContextWindowSource = 'models-list' | 'llama-slots' | 'model-status-args' | 'configured';

export interface ResolveContextWindowResult {
	contextWindow: number | undefined;
	effectiveBudget: number | undefined;
	source: ContextWindowSource;
}

export function resolveContextWindow(input: ResolveContextWindowInput): ResolveContextWindowResult {
	const generic = input.modelsListBody ? contextWindowFromModelsList(input.modelsListBody) : undefined;
	if (generic) {
		const caps: LlamaSlotCaps = { parallel: 1, slotContext: generic, kvUnified: true };
		return { contextWindow: generic, effectiveBudget: effectiveContextBudget(input.configured, caps), source: 'models-list' };
	}

	if (shouldProbeLlamaSlots(input.baseUrl)) {
		const slotsCaps = input.slotsBody ? parseLlamaSlots(input.slotsBody) : undefined;
		const statusCaps = !slotsCaps && input.modelStatusBody ? parseModelStatusArgs(input.modelStatusBody, input.modelId) : undefined;
		const caps = slotsCaps ?? statusCaps;
		if (caps) {
			return {
				contextWindow: caps.slotContext,
				effectiveBudget: effectiveContextBudget(input.configured, caps),
				source: slotsCaps ? 'llama-slots' : 'model-status-args',
			};
		}
	}

	return { contextWindow: undefined, effectiveBudget: input.configured, source: 'configured' };
}
