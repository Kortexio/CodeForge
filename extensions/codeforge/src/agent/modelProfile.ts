/**
 * Per-model harness profile. Defaults match today's hardcoded values.
 * Compensations live here; structural correctness (oracle, leak repair, mutationGuard) does not.
 */

import * as fs from 'fs';
import * as path from 'path';
import { modelProfileDir } from '../storage/paths';
import { applyOnlineHysteresis } from './profileHysteresis';

export type ModelProfile = {
	version: 1;
	serverId: string;
	model: string;
	sampling: {
		plan: { temperature: number; top_p: number };
		toolThinking: { temperature: number; top_p: number; presence_penalty: number };
		plain: { temperature: number; top_p: number };
	};
	completion: { mutatingMaxTokens: number; readOnlyMaxTokens: number };
	mutations: {
		/** 0 = no cap. Default 180 on weak write gate. */
		writeMaxContentLines: number;
		largeFileExistingLines: number;
		enforceMassRewriteGate: boolean;
	};
	finish: {
		maxDiagFinishNudges: number;
		specSelfCheckMaxNudges: number;
		specSelfCheckEnabled: boolean;
	};
	prompt: {
		renameSearchRule: boolean;
		shellCmdExeHints: boolean;
		forcedWeakSkill: boolean;
	};
	/**
	 * How tool calls are transported:
	 * - native: server parses tool_calls (default; strong models)
	 * - text: tools described in prompt; model emits XML/`tool_calls` in content; CodeForge parses
	 */
	toolTransport?: 'native' | 'text';
	weak: { maxWritesWithoutBuild: number };
	orchestrator: {
		autoMinCards: number;
		itemMaxSteps: number;
		itemHardCap: number;
		maxItemAttempts: number;
	};
	calibration?: {
		at: string;
		suite: string;
		passRate: number;
		meanScore: number;
		protocolMeans?: Record<string, number>;
		/** Set by calibrate: weak | strong */
		classification?: 'weak' | 'strong';
	};
	history?: Array<{ at: string; rule: string; from: unknown; to: unknown }>;
};

export function defaultModelProfile(serverId = '', model = ''): ModelProfile {
	return {
		version: 1,
		serverId,
		model,
		sampling: {
			plan: { temperature: 0.6, top_p: 0.95 },
			toolThinking: { temperature: 0.7, top_p: 0.8, presence_penalty: 0 },
			plain: { temperature: 0.2, top_p: 1 },
		},
		completion: { mutatingMaxTokens: 6144, readOnlyMaxTokens: 3072 },
		mutations: {
			writeMaxContentLines: 180,
			largeFileExistingLines: 60,
			enforceMassRewriteGate: true,
		},
		finish: {
			maxDiagFinishNudges: 2,
			specSelfCheckMaxNudges: 1,
			specSelfCheckEnabled: true,
		},
		prompt: {
			renameSearchRule: true,
			shellCmdExeHints: true,
			forcedWeakSkill: true,
		},
		weak: { maxWritesWithoutBuild: 2 },
		orchestrator: {
			autoMinCards: 2,
			itemMaxSteps: 25,
			itemHardCap: 40,
			maxItemAttempts: 2,
		},
		history: [],
	};
}

function deepMerge<T extends Record<string, unknown>>(base: T, over: Partial<T> | undefined): T {
	if (!over) return structuredClone(base);
	const out = structuredClone(base) as Record<string, unknown>;
	for (const [k, v] of Object.entries(over)) {
		if (v === undefined) continue;
		if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] && !Array.isArray(out[k])) {
			out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
		} else {
			out[k] = v;
		}
	}
	return out as T;
}

export function mergeModelProfile(base: ModelProfile, over: Partial<ModelProfile> | undefined): ModelProfile {
	return deepMerge(base as unknown as Record<string, unknown>, over as unknown as Record<string, unknown>) as unknown as ModelProfile;
}

export function profileFilePath(serverId: string, model: string): string {
	return path.join(modelProfileDir(serverId, model), 'profile.json');
}

export function saveModelProfile(profile: ModelProfile, filePath?: string): void {
	const fp = filePath ?? profileFilePath(profile.serverId, profile.model);
	fs.mkdirSync(path.dirname(fp), { recursive: true });
	fs.writeFileSync(fp, JSON.stringify(profile, null, 2), 'utf8');
}

export type LoadModelProfileOpts = {
	/** Skip creating the file on first load (tests). */
	createIfMissing?: boolean;
	/** Apply online hysteresis from rollup (default true for real runs). */
	applyHysteresis?: boolean;
	filePath?: string;
};

/**
 * Load profile from disk merged over defaults. Creates the file with defaults on first load.
 */
export function loadModelProfile(
	serverId: string,
	model: string,
	opts: LoadModelProfileOpts = {}
): ModelProfile {
	const create = opts.createIfMissing !== false;
	const applyHyst = opts.applyHysteresis !== false;
	const fp = opts.filePath ?? profileFilePath(serverId, model);
	let profile = defaultModelProfile(serverId, model);
	if (fs.existsSync(fp)) {
		try {
			const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<ModelProfile>;
			profile = mergeModelProfile(profile, { ...raw, serverId, model });
		} catch {
			/* keep default */
		}
	} else if (create) {
		saveModelProfile(profile, fp);
	}
	if (applyHyst) {
		const next = applyOnlineHysteresis(profile);
		if (next.changed) {
			profile = next.profile;
			saveModelProfile(profile, fp);
		}
	}
	return profile;
}

/**
 * Resolve profile for a run: disk profile, then optional server sampling override
 * (same precedence as opts.sampling over llmSamplingOptions).
 */
export function resolveProfileForRun(
	serverId: string,
	model: string,
	serverSampling?: {
		temperature?: number;
		top_p?: number;
		presence_penalty?: number;
	},
	opts?: LoadModelProfileOpts
): ModelProfile {
	const profile = loadModelProfile(serverId, model, opts);
	if (!serverSampling) return profile;
	const patch: Partial<ModelProfile> = { sampling: { ...profile.sampling } };
	const tool = { ...profile.sampling.toolThinking };
	if (typeof serverSampling.temperature === 'number') tool.temperature = serverSampling.temperature;
	if (typeof serverSampling.top_p === 'number') tool.top_p = serverSampling.top_p;
	if (typeof serverSampling.presence_penalty === 'number') {
		tool.presence_penalty = serverSampling.presence_penalty;
	}
	patch.sampling = {
		...profile.sampling,
		toolThinking: tool,
		plain: {
			...profile.sampling.plain,
			...(typeof serverSampling.temperature === 'number'
				? { temperature: serverSampling.temperature }
				: {}),
			...(typeof serverSampling.top_p === 'number' ? { top_p: serverSampling.top_p } : {}),
		},
	};
	return mergeModelProfile(profile, patch);
}

export type CalibrationStats = {
	passRate: number;
	badArgsRate: number;
	lengthExits: number;
	totalRuns: number;
	/** Native tool_calls observed (0 → never trust "strong" for local XML models). */
	nativeToolCalls?: number;
};

export type CalibrationClass = 'weak' | 'strong';

/**
 * Classify from protocol + pass rate — not from model name.
 * Clean tool protocol → strong (drop cost knobs); otherwise keep weak defaults.
 * Strong requires a minimum pass rate and at least one native tool call when measured.
 */
export function classifyCalibration(stats: CalibrationStats): CalibrationClass {
	if (stats.totalRuns < 1) return 'weak';
	if (stats.passRate < 0.5) return 'weak';
	if (typeof stats.nativeToolCalls === 'number' && stats.nativeToolCalls <= 0) return 'weak';
	if (stats.badArgsRate < 0.05 && stats.lengthExits === 0) return 'strong';
	return 'weak';
}

/** Reset to hand-tuned weak defaults (ignore online flips from the calibrate window). */
export function applyWeakCalibration(profile: ModelProfile): ModelProfile {
	const def = defaultModelProfile(profile.serverId, profile.model);
	const next = structuredClone(profile);
	next.sampling = def.sampling;
	next.mutations = def.mutations;
	next.completion = def.completion;
	next.finish = { ...def.finish, specSelfCheckEnabled: true };
	next.prompt = { ...def.prompt, forcedWeakSkill: true };
	next.weak = def.weak;
	return next;
}

/** Strong-model knobs when protocol looks clean. */
export function applyStrongCalibration(
	profile: ModelProfile,
	stats: CalibrationStats
): ModelProfile {
	const next = structuredClone(profile);
	if (stats.totalRuns < 1) return next;
	next.mutations.enforceMassRewriteGate = false;
	next.mutations.writeMaxContentLines = 0;
	next.prompt.forcedWeakSkill = false;
	if (stats.passRate >= 11 / 12) {
		next.finish.specSelfCheckEnabled = false;
	}
	return next;
}

/** Classify then apply weak or strong knobs. */
export function applyCalibrationFromStats(
	profile: ModelProfile,
	stats: CalibrationStats
): { profile: ModelProfile; classification: CalibrationClass } {
	const classification = classifyCalibration(stats);
	if (classification === 'strong') {
		return { profile: applyStrongCalibration(profile, stats), classification };
	}
	return { profile: applyWeakCalibration(profile), classification };
}
