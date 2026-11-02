/**
 * Automatic vision-model routing for image attachments.
 *
 * A user can attach an image to a chat turn regardless of which server/model is
 * currently active. Only some models accept image input. This module decides,
 * for a turn that carries images, which configured server+model to actually call:
 *
 *  1. The active server/model, when it already accepts images — no switch.
 *  2. Another model on the active server, when that server has one — same
 *     server, no server switch, just a different model for this call.
 *  3. A model on a different configured, enabled server — a full switch,
 *     transparent to the user (same mechanism either way, from the caller's
 *     point of view it just resolves a target to call).
 *  4. Nothing: no server has an image-capable model anywhere in the user's
 *     configuration. Callers must not let the user attach images in this case
 *     (see {@link anyVisionModelAvailable}).
 *
 * Detection, in priority order:
 *  - `AiServer.visionModels`, filled in by "Refresh from API" when the server's
 *    `/v1/models` response carries capability metadata (llama.cpp / llama-swap:
 *    `capabilities: ["completion", "multimodal"]`).
 *  - A name heuristic, `modelLikelySupportsVision`, for servers/models that
 *    don't expose capability metadata (most cloud providers, Ollama tags).
 */

import type { AiServer, AiSettingsState } from '../settings/aiSettingsStore';

/** Local/open-weight vision-language model families, by naming convention. */
const VISION_NAME_RE =
	/\b(vl|vision|llava|moondream\d*|pixtral|minicpm-v|internvl|cogvlm|idefics|fuyu|yi-vl|bakllava)\b/i;

/** `qwen2-vl`, `qwen2.5-vl`, `qwen3-vl`, etc. — the `vl` token above needs a `-` or digit boundary to not match unrelated ids. */
const QWEN_VL_RE = /qwen[\d.]*-vl\b/i;

/** Current-generation flagship cloud chat models that accept image input by default. */
const CLOUD_VISION_RE =
	/\b(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|claude-3|claude-4|claude-opus|claude-sonnet|claude-haiku|gemini)\b/i;

/** Cloud model ids that are known text/audio-only despite the provider generally supporting vision. */
const CLOUD_TEXT_ONLY_RE = /\b(embedding|whisper|tts|moderation|instruct|gpt-3\.5|davinci|babbage|ada)\b/i;

const CLOUD_KINDS = new Set<AiServer['kind']>(['openai', 'anthropic', 'google', 'openrouter']);

/** Name heuristic — fallback for servers/models with no measured vision capability. */
export function modelLikelySupportsVision(kind: AiServer['kind'], model: string | undefined): boolean {
	const id = String(model ?? '').trim();
	if (!id) return false;
	if (VISION_NAME_RE.test(id) || QWEN_VL_RE.test(id)) return true;
	if (CLOUD_KINDS.has(kind)) {
		if (CLOUD_TEXT_ONLY_RE.test(id)) return false;
		return CLOUD_VISION_RE.test(id);
	}
	return false;
}

/** Model ids on this server known, or believed, to accept image input. */
export function visionModelsForServer(server: AiServer): string[] {
	if (Array.isArray(server.visionModels) && server.visionModels.length) {
		// Measured capability wins, but only for models still in the current list
		// (a model removed from `models` during a refresh must not linger here).
		const known = new Set(server.models);
		const measured = server.visionModels.filter(m => known.has(m));
		if (measured.length) return measured;
	}
	return server.models.filter(m => modelLikelySupportsVision(server.kind, m));
}

export function serverSupportsVision(server: AiServer): boolean {
	return visionModelsForServer(server).length > 0;
}

export interface VisionRoute {
	serverId: string;
	model: string;
	/** True when this is exactly the already-active server + model — no switch happened. */
	sameAsActive: boolean;
}

/**
 * Pick the server+model to use for a turn that carries image attachments.
 * Returns `null` when no configured, enabled server has an image-capable model.
 */
export function resolveVisionRoute(
	state: AiSettingsState,
	activeServerId: string | undefined,
	activeModel: string | undefined
): VisionRoute | null {
	const servers = (state.servers ?? []).filter(s => s.enabled);
	if (!servers.length) return null;

	const active = servers.find(s => s.id === activeServerId);
	if (active && activeModel) {
		const activeVision = visionModelsForServer(active);
		if (activeVision.includes(activeModel)) {
			return { serverId: active.id, model: activeModel, sameAsActive: true };
		}
	}

	// Prefer staying on the active server with a different (vision-capable) model
	// over switching servers, when it has one.
	if (active) {
		const activeVision = visionModelsForServer(active);
		if (activeVision.length) {
			return { serverId: active.id, model: activeVision[0], sameAsActive: false };
		}
	}

	for (const server of servers) {
		if (server.id === activeServerId) continue;
		const visionModels = visionModelsForServer(server);
		if (visionModels.length) {
			return { serverId: server.id, model: visionModels[0], sameAsActive: false };
		}
	}
	return null;
}

/** Whether at least one configured, enabled server has an image-capable model — gates the attach-image UI. */
export function anyVisionModelAvailable(state: AiSettingsState): boolean {
	return (state.servers ?? []).some(s => s.enabled && serverSupportsVision(s));
}
