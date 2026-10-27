/**
 * Online hysteresis: flip profile knobs at run start from protocol rollup signals.
 * Quality knobs (spec-check, orchestrator) are never flipped here — only protocol/cost.
 *
 * Cooldown is structural: after a flip, configHash changes, so the window of matching
 * chat runs restarts empty until enough new evidence arrives.
 */

import {
	loadModelRollup,
	runsForConfig,
	runsForSource,
	truncatedToolJsonRate,
	unrepairedLeakRate,
	type ProtocolRollup,
	type RunTelemetryRecord,
} from './protocolTelemetry';
import { profileConfigHash } from './harnessFingerprint';
import type { ModelProfile } from './modelProfile';

const HISTORY_CAP = 40;
const MIN_RUNS = 10;

export type HysteresisResult = {
	profile: ModelProfile;
	changed: boolean;
	flips: Array<{ rule: string; from: unknown; to: unknown }>;
};

function pushHistory(
	profile: ModelProfile,
	rule: string,
	from: unknown,
	to: unknown,
	evidence?: Record<string, unknown>
): void {
	const entry = {
		at: new Date().toISOString(),
		rule,
		from,
		to,
		...(evidence ? { evidence } : {}),
	};
	profile.history = [...(profile.history ?? []), entry].slice(-HISTORY_CAP);
}

function isFrozen(profile: ModelProfile, rulePrefix: string): boolean {
	const hist = profile.history ?? [];
	for (let i = hist.length - 1; i >= 0; i--) {
		const r = String(hist[i]?.rule || '');
		if (r === `${rulePrefix}.frozen`) return true;
		if (r.startsWith(`${rulePrefix}.`) && r.endsWith('.unfrozen')) return false;
	}
	return false;
}

function activeToolSlice(profile: ModelProfile): 'toolThinking' | 'toolReasoning' {
	return profile.thinking?.toolRounds ? 'toolReasoning' : 'toolThinking';
}

function truncRateOn(runs: RunTelemetryRecord[]): number {
	if (!runs.length) return 0;
	let hits = 0;
	for (const r of runs) {
		if (r.sampleReasons.some(x => x === 'truncated_tool_json')) hits += 1;
	}
	return hits / runs.length;
}

/**
 * Apply online rules over chat runs that match the current config hash.
 * Returns a new profile object when something flips.
 */
export function applyOnlineHysteresis(profile: ModelProfile): HysteresisResult {
	if (process.env.CODEFORGE_DISABLE_HYSTERESIS === '1') {
		return { profile, changed: false, flips: [] };
	}
	const rollup = loadModelRollup(profile.serverId, profile.model);
	if (!rollup) {
		return { profile, changed: false, flips: [] };
	}

	const configHash = profileConfigHash(profile, 0);
	const chatRuns = runsForSource(rollup, 'chat');
	const window = runsForConfig(
		{ ...rollup, recent: chatRuns } as ProtocolRollup,
		configHash
	);
	// Prefer stamped chat runs; fall back to all chat runs only when none are stamped yet
	// (legacy rollups). Never use bench runs.
	const evidenceRuns =
		window.length >= MIN_RUNS
			? window
			: chatRuns.filter(r => !r.configHash).length >= MIN_RUNS
				? chatRuns.filter(r => !r.configHash)
				: window.length
					? window
					: [];
	if (evidenceRuns.length < MIN_RUNS) {
		return { profile, changed: false, flips: [] };
	}

	const next = structuredClone(profile);
	const flips: Array<{ rule: string; from: unknown; to: unknown }> = [];
	const truncRate = truncRateOn(evidenceRuns);
	const leakRate = unrepairedLeakRate(evidenceRuns);
	const fullWindow = evidenceRuns.length >= 50;

	if (!isFrozen(next, 'writeCap')) {
		if (truncRate >= 0.05 && next.mutations.writeMaxContentLines === 0) {
			pushHistory(next, 'writeCap.on', 0, 180, {
				rate: truncRate,
				runs: evidenceRuns.length,
				configHash,
			});
			flips.push({ rule: 'writeCap.on', from: 0, to: 180 });
			next.mutations.writeMaxContentLines = 180;
		} else if (fullWindow && truncRate < 0.01 && next.mutations.writeMaxContentLines > 0) {
			pushHistory(next, 'writeCap.off', next.mutations.writeMaxContentLines, 0, {
				rate: truncRate,
				runs: evidenceRuns.length,
				configHash,
			});
			flips.push({
				rule: 'writeCap.off',
				from: next.mutations.writeMaxContentLines,
				to: 0,
			});
			next.mutations.writeMaxContentLines = 0;
		}
	}

	const slice = activeToolSlice(next);
	if (!isFrozen(next, 'toolTemp') && leakRate >= 0.08) {
		const cur = next.sampling[slice].temperature;
		const target = Math.max(0.3, Math.round((cur - 0.1) * 100) / 100);
		if (target < cur) {
			pushHistory(next, 'toolTemp.down', cur, target, {
				rate: leakRate,
				runs: evidenceRuns.length,
				configHashBefore: configHash,
				slice,
			});
			flips.push({ rule: 'toolTemp.down', from: cur, to: target });
			next.sampling[slice].temperature = target;
		}
	}

	// Revert a prior toolTemp.down only after enough evidence under the *new* config
	// (configHash of this load differs from the hash recorded at the down flip).
	const lastDown = [...(next.history ?? [])]
		.reverse()
		.find(h => h.rule === 'toolTemp.down');
	const downEvidence = (lastDown as { evidence?: { rate?: number; configHashBefore?: string } } | undefined)
		?.evidence;
	const downHash = downEvidence?.configHashBefore;
	const underNewConfig =
		!!downHash &&
		configHash !== downHash &&
		evidenceRuns.length >= MIN_RUNS &&
		evidenceRuns.every(r => !r.configHash || r.configHash === configHash);
	if (
		lastDown &&
		underNewConfig &&
		!isFrozen(next, 'toolTemp') &&
		!flips.some(f => f.rule === 'toolTemp.down')
	) {
		const priorRate = typeof downEvidence?.rate === 'number' ? downEvidence.rate : undefined;
		if (priorRate !== undefined && leakRate >= priorRate - 0.01) {
			const from = next.sampling[slice].temperature;
			const to = Number(lastDown.from);
			if (Number.isFinite(to) && to > from) {
				pushHistory(next, 'toolTemp.revert', from, to, {
					rate: leakRate,
					runs: evidenceRuns.length,
					configHash,
				});
				pushHistory(next, 'toolTemp.frozen', true, true, { reason: 'no improvement' });
				flips.push({ rule: 'toolTemp.revert', from, to });
				next.sampling[slice].temperature = to;
			}
		}
	}

	return { profile: next, changed: flips.length > 0, flips };
}

/** Test helper: trunc rate over an arbitrary run list (chat-only paths use unrepairedLeakRate). */
export function truncatedToolJsonRateCompat(rollup: ProtocolRollup): number {
	return truncatedToolJsonRate(rollup);
}
