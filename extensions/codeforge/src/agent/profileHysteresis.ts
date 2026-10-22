/**
 * Online hysteresis: flip profile knobs at run start from protocol rollup signals.
 * Quality knobs (spec-check, orchestrator) are never flipped here — only protocol/cost.
 */

import { loadModelRollup, leakedParamRate, truncatedToolJsonRate } from './protocolTelemetry';
import type { ModelProfile } from './modelProfile';

const HISTORY_CAP = 40;

export type HysteresisResult = {
	profile: ModelProfile;
	changed: boolean;
	flips: Array<{ rule: string; from: unknown; to: unknown }>;
};

function pushHistory(
	profile: ModelProfile,
	rule: string,
	from: unknown,
	to: unknown
): void {
	const entry = { at: new Date().toISOString(), rule, from, to };
	profile.history = [...(profile.history ?? []), entry].slice(-HISTORY_CAP);
}

/**
 * Apply online rules over the last 50 runs in the rollup.
 * Returns a new profile object when something flips.
 */
export function applyOnlineHysteresis(profile: ModelProfile): HysteresisResult {
	if (process.env.CODEFORGE_DISABLE_HYSTERESIS === '1') {
		return { profile, changed: false, flips: [] };
	}
	const rollup = loadModelRollup(profile.serverId, profile.model);
	// Need a meaningful window; off-transition requires the full 50-run hysteresis window.
	if (!rollup || rollup.recent.length < 10) {
		return { profile, changed: false, flips: [] };
	}

	const next = structuredClone(profile);
	const flips: Array<{ rule: string; from: unknown; to: unknown }> = [];
	const truncRate = truncatedToolJsonRate(rollup);
	const leakRate = leakedParamRate(rollup);
	const fullWindow = rollup.recent.length >= 50;

	// Write cap: on when truncations are common; off only after a full clean window.
	if (truncRate >= 0.05 && next.mutations.writeMaxContentLines === 0) {
		pushHistory(next, 'writeCap.on', 0, 180);
		flips.push({ rule: 'writeCap.on', from: 0, to: 180 });
		next.mutations.writeMaxContentLines = 180;
	} else if (
		fullWindow &&
		truncRate < 0.01 &&
		next.mutations.writeMaxContentLines > 0
	) {
		pushHistory(next, 'writeCap.off', next.mutations.writeMaxContentLines, 0);
		flips.push({
			rule: 'writeCap.off',
			from: next.mutations.writeMaxContentLines,
			to: 0,
		});
		next.mutations.writeMaxContentLines = 0;
	}

	// Leak rate high → nudge temperature down slightly (tool rounds).
	if (leakRate >= 0.08) {
		const cur = next.sampling.toolThinking.temperature;
		const target = Math.max(0.3, Math.round((cur - 0.1) * 100) / 100);
		if (target < cur) {
			pushHistory(next, 'toolTemp.down', cur, target);
			flips.push({ rule: 'toolTemp.down', from: cur, to: target });
			next.sampling.toolThinking.temperature = target;
		}
	}

	return { profile: next, changed: flips.length > 0, flips };
}
