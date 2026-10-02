/**
 * Read llama.cpp server slot layout (parallel + per-slot context).
 * Router: GET /slots?model=id. Direct server: GET /slots.
 * Fallback: --parallel / --ctx-size / --kv-unified on the model status args.
 */

export interface LlamaSlotCaps {
	/** Concurrent sequences the server will accept (--parallel). */
	parallel: number;
	/** Tokens one request may use (slot n_ctx, already split or unified). */
	slotContext: number;
	kvUnified: boolean;
}

const CLOUD_HOST =
	/(?:^|\.)(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.x\.ai|openrouter\.ai)(?::\d+)?$/i;

export function serverRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function shouldProbeLlamaSlots(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).host;
		return !CLOUD_HOST.test(host);
	} catch {
		return false;
	}
}

export function parseLlamaSlots(body: unknown): LlamaSlotCaps | undefined {
	if (!Array.isArray(body) || body.length === 0) return undefined;
	const ctxs: number[] = [];
	for (const row of body) {
		const n = Number((row as { n_ctx?: unknown })?.n_ctx);
		if (Number.isFinite(n) && n > 0) ctxs.push(n);
	}
	if (!ctxs.length) return undefined;
	return {
		parallel: body.length,
		slotContext: Math.min(...ctxs),
		// /slots reports n_ctx per slot; kv-unified is only known from argv.
		kvUnified: false,
	};
}

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) {
		return args[i + 1];
	}
	const prefix = `${name}=`;
	const hit = args.find(a => a.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : undefined;
}

function positiveInt(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** llama-server argv, or the same flags from a router model status.args list. */
export function capsFromArgs(args: string[]): LlamaSlotCaps | undefined {
	const parallel = positiveInt(flagValue(args, '--parallel')) ?? 1;
	const ctx = positiveInt(flagValue(args, '--ctx-size'));
	if (!ctx) return undefined;
	const kvUnified = args.includes('--kv-unified');
	const slotContext = kvUnified ? ctx : Math.max(1, Math.floor(ctx / parallel));
	return { parallel, slotContext, kvUnified };
}

export function parseModelStatusArgs(body: unknown, modelId: string): LlamaSlotCaps | undefined {
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) return undefined;
	const row = data.find(m => (m as { id?: string })?.id === modelId) as
		| { status?: { args?: unknown } }
		| undefined;
	const args = row?.status?.args;
	if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) return undefined;
	return capsFromArgs(args);
}

/** Client budget cannot exceed the live slot window. */
export function effectiveContextBudget(
	configured: number | undefined,
	caps: LlamaSlotCaps | undefined
): number | undefined {
	if (!caps || caps.slotContext <= 0) return configured;
	if (!configured || configured <= 0) return caps.slotContext;
	return Math.min(configured, caps.slotContext);
}

export function formatLlamaSlotsLine(
	model: string,
	caps: LlamaSlotCaps,
	configured?: number
): string {
	const unified = caps.kvUnified ? ', kv-unified' : '';
	const base = `Llama.cpp slots: ${model} parallel=${caps.parallel} n_ctx=${caps.slotContext}${unified}`;
	if (configured && configured > caps.slotContext) {
		return `${base} (context budget ${configured} clamped to slot size)`;
	}
	return base;
}

interface SlotCache {
	serverId: string;
	model: string;
	caps?: LlamaSlotCaps;
}

let cache: SlotCache | undefined;

export function llamaSlotsProbed(serverId: string, model: string): boolean {
	return !!cache && cache.serverId === serverId && cache.model === model;
}

export function cachedLlamaSlots(serverId: string, model: string): LlamaSlotCaps | undefined {
	if (cache && cache.serverId === serverId && cache.model === model) return cache.caps;
	return undefined;
}

export function clearLlamaSlotCache(): void {
	cache = undefined;
}

async function getJson(url: string, apiKey: string | undefined, signal: AbortSignal): Promise<unknown> {
	const res = await fetch(url, {
		method: 'GET',
		signal,
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	return res.json();
}

export async function refreshLlamaSlots(opts: {
	serverId: string;
	model: string;
	baseUrl: string;
	apiKey?: string;
	configuredCtx?: number;
	log?: (line: string) => void;
	timeoutMs?: number;
}): Promise<LlamaSlotCaps | undefined> {
	if (!opts.model || !shouldProbeLlamaSlots(opts.baseUrl)) {
		return undefined;
	}
	const root = serverRoot(opts.baseUrl);
	const v1 = opts.baseUrl.replace(/\/+$/, '');
	const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000);
	let caps: LlamaSlotCaps | undefined;
	try {
		const slots = await getJson(
			`${root}/slots?model=${encodeURIComponent(opts.model)}`,
			opts.apiKey,
			signal
		);
		caps = parseLlamaSlots(slots);
	} catch {
		caps = undefined;
	}
	if (!caps) {
		try {
			const modelsUrl = /\/v1$/i.test(v1) ? `${v1}/models` : `${root}/v1/models`;
			const models = await getJson(modelsUrl, opts.apiKey, signal);
			caps = parseModelStatusArgs(models, opts.model);
		} catch {
			caps = undefined;
		}
	}
	cache = { serverId: opts.serverId, model: opts.model, caps };
	if (!caps) {
		opts.log?.(`Llama.cpp slots: unavailable for ${opts.model}`);
		return undefined;
	}
	opts.log?.(formatLlamaSlotsLine(opts.model, caps, opts.configuredCtx));
	return caps;
}
