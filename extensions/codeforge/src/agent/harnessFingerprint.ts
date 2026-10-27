/**
 * Stable fingerprints for what the model receives (contract) and which knobs
 * were active (config). Learners only trust runs stamped with the current hashes.
 */

import { createHash } from 'crypto';
import { buildToolSystemContract } from './toolContracts';
import { defaultModelProfile, type ModelProfile } from './modelProfile';

function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Hash of the tool+system contract and default profile the model sees.
 * Optional toolSchemas lets the caller include the live AGENT_TOOLS surface.
 */
export function contractFingerprint(opts?: {
	toolSchemas?: unknown;
	contractText?: string;
}): string {
	const contract = opts?.contractText ?? buildToolSystemContract(undefined);
	const defaults = defaultModelProfile('', '');
	const payload = [
		'v1',
		contract,
		stableStringify(opts?.toolSchemas ?? null),
		stableStringify({
			sampling: defaults.sampling,
			completion: defaults.completion,
			thinking: defaults.thinking,
			mutations: defaults.mutations,
			finish: defaults.finish,
			prompt: defaults.prompt,
			weak: defaults.weak,
			orchestrator: defaults.orchestrator,
		}),
	].join('\n---\n');
	return sha256Hex(payload);
}

/** Hash of the runtime knobs that change behavior for a given model profile. */
export function profileConfigHash(
	profile: ModelProfile,
	harnessRevision = 0
): string {
	const payload = stableStringify({
		sampling: profile.sampling,
		completion: profile.completion,
		thinking: profile.thinking,
		mutations: profile.mutations,
		finish: profile.finish,
		prompt: profile.prompt,
		toolTransport: profile.toolTransport ?? 'native',
		weak: profile.weak,
		orchestrator: profile.orchestrator,
		harnessRevision,
	});
	return sha256Hex(payload);
}

export type RunConfigStamp = {
	contract: string;
	configHash: string;
	harnessRevision: number;
};

export function stampForProfile(
	profile: ModelProfile,
	harnessRevision = 0,
	toolSchemas?: unknown
): RunConfigStamp {
	return {
		contract: contractFingerprint({ toolSchemas }),
		configHash: profileConfigHash(profile, harnessRevision),
		harnessRevision,
	};
}
