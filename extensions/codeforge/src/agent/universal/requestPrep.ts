/**
 * Per-family request preparation, run immediately before every provider call (the plan's "the
 * `forModel()` call site today only filters attachments" gap). Three independent concerns:
 *
 * - `sanitizeToolSchemas`: strips `^…$` regex anchors from tool parameter `pattern` strings for
 *   families with a known anchor-bleed bug (Kimi, GLM, MiniMax) — the model has been observed
 *   literally copying the anchors from the schema into output values.
 * - `normalizeToolCallIds`: reshapes replayed tool_call ids into the family's expected id shape
 *   (Kimi `functions.{name}:{idx}`, Mistral's 9-char alphanumeric) so history does not show the
 *   model a foreign id shape and prompt it to imitate something else.
 * - `dropForeignReasoning`: discards `reasoning`/`reasoning_content`/`thinking` from assistant
 *   messages produced by a *different* model family (cross-provider fallback mid-conversation),
 *   mirroring pi-ai's cross-provider handoff rule — keeps tool calls and text, drops reasoning.
 */

import type { ModelFamilyProfile } from './modelFamily';
import type { JsonSchemaObject } from './schemaRepair';

function stripAnchors(pattern: string): string {
	let p = pattern;
	if (p.startsWith('^')) p = p.slice(1);
	if (p.endsWith('$') && !p.endsWith('\\$')) p = p.slice(0, -1);
	return p;
}

function sanitizeSchema(schema: JsonSchemaObject): JsonSchemaObject {
	const out: JsonSchemaObject = { ...schema };
	if (typeof out.pattern === 'string') {
		out.pattern = stripAnchors(out.pattern);
	}
	const props = out.properties as Record<string, JsonSchemaObject> | undefined;
	if (props) {
		out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sanitizeSchema(v)]));
	}
	const items = out.items as JsonSchemaObject | undefined;
	if (items) {
		out.items = sanitizeSchema(items);
	}
	return out;
}

/** Only applied when `profile.anchorBleed` is set — a no-op copy otherwise. */
export function sanitizeToolSchemas<T extends { function?: { parameters?: JsonSchemaObject } }>(
	tools: T[],
	profile: ModelFamilyProfile | undefined
): T[] {
	if (!profile?.anchorBleed) return tools;
	return tools.map((t) => {
		if (!t.function?.parameters) return t;
		return { ...t, function: { ...t.function, parameters: sanitizeSchema(t.function.parameters) } };
	});
}

function base36Hash(input: string): string {
	let h = 0;
	for (let i = 0; i < input.length; i++) {
		h = (h * 31 + input.charCodeAt(i)) >>> 0;
	}
	return h.toString(36);
}

function mistral9Id(seed: string): string {
	const chars = (base36Hash(seed) + base36Hash(seed + 'x') + '000000000').toUpperCase();
	return chars.slice(0, 9);
}

export interface ToolCallIdLike {
	id: string;
	function: { name: string };
}

/** Reshapes ids into the family's expected format; a no-op when the profile declares none. */
export function normalizeToolCallIds<T extends ToolCallIdLike>(calls: T[], profile: ModelFamilyProfile | undefined): T[] {
	if (!profile?.toolCallIdFormat) return calls;
	return calls.map((c, idx) => {
		if (profile.toolCallIdFormat === 'kimi') {
			if (/^functions\.[^:]+:\d+$/.test(c.id)) return c;
			return { ...c, id: `functions.${c.function.name}:${idx}` };
		}
		if (profile.toolCallIdFormat === 'mistral9') {
			if (/^[A-Za-z0-9]{9}$/.test(c.id)) return c;
			return { ...c, id: mistral9Id(c.id || `${c.function.name}:${idx}`) };
		}
		return c;
	});
}

export interface ReasoningMsgLike {
	role: string;
	/** Which family produced this assistant turn, when the caller tracks it across fallbacks. */
	modelFamily?: string;
	reasoning?: unknown;
	reasoning_content?: unknown;
	thinking?: unknown;
}

/**
 * Drops reasoning left over from a different model family after a provider/model fallback.
 * A message with no `modelFamily` tag is left untouched (conservative default — nothing to
 * compare against).
 */
export function dropForeignReasoning<T extends ReasoningMsgLike>(messages: T[], currentFamily: string | undefined): T[] {
	if (!currentFamily) return messages;
	return messages.map((m) => {
		if (m.role !== 'assistant' || !m.modelFamily || m.modelFamily === currentFamily) return m;
		const next = { ...m } as Record<string, unknown>;
		delete next.reasoning;
		delete next.reasoning_content;
		delete next.thinking;
		return next as T;
	});
}
