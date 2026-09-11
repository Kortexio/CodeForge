/**
 * Detect small / local models that need the weak-model harness.
 */

export type WeakModelMode = 'auto' | 'force' | 'off';

export interface WeakModelHints {
	modelId?: string | null;
	baseUrl?: string | null;
	numCtx?: number | null;
}

const STRONG_NAME =
	/\b(claude-opus|claude-sonnet-4|gpt-4|gpt-5|o1\b|o3\b|gemini-2\.5-pro|405b|70b|72b|65b|671b)\b/i;

const LOCAL_QUANT = /\b(exl3|exllama|gguf|q4_|q5_|q6_|iq4|iq3|awq|gptq)\b/i;

const LAN_HOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i;

/** Extract parameter count in billions from a model id, if present. */
export function parseParamsBillions(modelId: string): number | undefined {
	const id = modelId.toLowerCase();
	const moe = id.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
	if (moe) {
		const a = Number(moe[1]);
		const b = Number(moe[2]);
		if (Number.isFinite(a) && Number.isFinite(b)) {
			return a * b;
		}
	}
	const m = id.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/i);
	if (m) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

/**
 * Heuristic: treat as weak if <=34B, local quant names, or LAN+small ctx.
 * Strong cloud/frontier names force false.
 */
export function isWeakModel(hints: WeakModelHints, mode: WeakModelMode = 'auto'): boolean {
	if (mode === 'force') return true;
	if (mode === 'off') return false;

	const modelId = String(hints.modelId ?? '').trim();
	const baseUrl = String(hints.baseUrl ?? '').trim();
	const numCtx = hints.numCtx ?? undefined;

	if (modelId && STRONG_NAME.test(modelId)) {
		return false;
	}

	const paramsB = modelId ? parseParamsBillions(modelId) : undefined;
	if (paramsB !== undefined && paramsB <= 34) {
		return true;
	}
	if (paramsB !== undefined && paramsB >= 70) {
		return false;
	}

	if (modelId && LOCAL_QUANT.test(modelId)) {
		return true;
	}

	if (baseUrl && LAN_HOST.test(baseUrl) && (numCtx === undefined || numCtx <= 16384)) {
		return true;
	}

	// Unknown cloud model without size → not weak (avoid over-harnessing).
	return false;
}

export function resolveWeakModelMode(raw: unknown): WeakModelMode {
	const v = String(raw ?? 'auto').toLowerCase();
	if (v === 'force' || v === 'off' || v === 'auto') return v;
	return 'auto';
}
