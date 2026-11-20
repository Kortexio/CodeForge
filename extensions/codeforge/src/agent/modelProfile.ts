/**
 * Per-model harness profile. Defaults match today's hardcoded values.
 * Compensations live here; structural correctness (oracle, leak repair, mutationGuard) does not.
 */

import * as fs from 'fs';
import * as path from 'path';
import { modelProfileDir, modelProfilesRoot } from '../storage/paths';
import { applyOnlineHysteresis } from './profileHysteresis';
import { EFFECTFUL_TOOLS } from './finishGate';

export type ModelProfileRef = {
	serverId: string;
	model: string;
	path: string;
	exists: boolean;
};

/** Profiles already on disk under ~/.CodeForge/ai/model-profiles/. */
export function listModelProfileRefs(): ModelProfileRef[] {
	const root = modelProfilesRoot();
	if (!fs.existsSync(root)) return [];
	const out: ModelProfileRef[] = [];
	for (const serverEnt of fs.readdirSync(root, { withFileTypes: true })) {
		if (!serverEnt.isDirectory()) continue;
		const serverDir = path.join(root, serverEnt.name);
		for (const modelEnt of fs.readdirSync(serverDir, { withFileTypes: true })) {
			if (!modelEnt.isDirectory()) continue;
			const fp = path.join(serverDir, modelEnt.name, 'profile.json');
			let serverId = serverEnt.name;
			let model = modelEnt.name;
			if (fs.existsSync(fp)) {
				try {
					const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<ModelProfile>;
					if (typeof raw.serverId === 'string' && raw.serverId.trim()) serverId = raw.serverId.trim();
					if (typeof raw.model === 'string' && raw.model.trim()) model = raw.model.trim();
				} catch {
					/* keep dir names */
				}
			}
			out.push({ serverId, model, path: fp, exists: fs.existsSync(fp) });
		}
	}
	return out.sort((a, b) =>
		`${a.serverId}/${a.model}`.localeCompare(`${b.serverId}/${b.model}`, undefined, {
			sensitivity: 'base',
		})
	);
}

/**
 * Disk profiles plus models configured on servers (so the editor can create a file on save).
 */
export function collectModelProfileChoices(
	servers: Array<{ id: string; models?: string[] }>
): ModelProfileRef[] {
	const map = new Map<string, ModelProfileRef>();
	const keyOf = (serverId: string, model: string) => `${serverId}\0${model}`;
	for (const ref of listModelProfileRefs()) {
		map.set(keyOf(ref.serverId, ref.model), ref);
	}
	for (const s of servers) {
		const serverId = String(s.id ?? '').trim();
		if (!serverId) continue;
		for (const m of s.models ?? []) {
			const model = String(m ?? '').trim();
			if (!model) continue;
			const key = keyOf(serverId, model);
			if (map.has(key)) continue;
			const fp = profileFilePath(serverId, model);
			map.set(key, {
				serverId,
				model,
				path: fp,
				exists: fs.existsSync(fp),
			});
		}
	}
	return [...map.values()].sort((a, b) =>
		`${a.serverId}/${a.model}`.localeCompare(`${b.serverId}/${b.model}`, undefined, {
			sensitivity: 'base',
		})
	);
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Apply Settings → Profile form values onto a base profile (keeps unrelated knobs). */
export function applyProfileEditorPatch(
	base: ModelProfile,
	patch: {
		thinking?: Partial<ModelProfile['thinking']>;
		sampling?: {
			plan?: Partial<ModelProfile['sampling']['plan']>;
			toolThinking?: Partial<ModelProfile['sampling']['toolThinking']>;
			toolReasoning?: Partial<ModelProfile['sampling']['toolReasoning']>;
			plain?: Partial<ModelProfile['sampling']['plain']>;
		};
		completion?: Partial<ModelProfile['completion']>;
		toolTransport?: ToolTransport | '';
	}
): ModelProfile {
	const next = structuredClone(base);
	const th = patch.thinking;
	if (th) {
		if (typeof th.toolRounds === 'boolean') next.thinking.toolRounds = th.toolRounds;
		if (typeof th.escalate === 'boolean') next.thinking.escalate = th.escalate;
		if (th.maxEscalationsPerTurn !== undefined) {
			next.thinking.maxEscalationsPerTurn = Math.round(
				clampNumber(th.maxEscalationsPerTurn, next.thinking.maxEscalationsPerTurn, 0, 32)
			);
		}
		if (th.maxTokens !== undefined) {
			next.thinking.maxTokens = Math.round(
				clampNumber(th.maxTokens, next.thinking.maxTokens, 256, 65536)
			);
		}
	}
	const samp = patch.sampling;
	if (samp?.plan) {
		if (samp.plan.temperature !== undefined) {
			next.sampling.plan.temperature = clampNumber(samp.plan.temperature, next.sampling.plan.temperature, 0, 2);
		}
		if (samp.plan.top_p !== undefined) {
			next.sampling.plan.top_p = clampNumber(samp.plan.top_p, next.sampling.plan.top_p, 0, 1);
		}
	}
	const patchSlice = (
		target: { temperature: number; top_p: number; presence_penalty?: number },
		src: Partial<{ temperature: number; top_p: number; presence_penalty: number }> | undefined
	) => {
		if (!src) return;
		if (src.temperature !== undefined) {
			target.temperature = clampNumber(src.temperature, target.temperature, 0, 2);
		}
		if (src.top_p !== undefined) {
			target.top_p = clampNumber(src.top_p, target.top_p, 0, 1);
		}
		if (src.presence_penalty !== undefined && 'presence_penalty' in target) {
			target.presence_penalty = clampNumber(
				src.presence_penalty,
				target.presence_penalty ?? 0,
				-2,
				2
			);
		}
	};
	if (samp) {
		patchSlice(next.sampling.toolThinking, samp.toolThinking);
		patchSlice(next.sampling.toolReasoning, samp.toolReasoning);
		if (samp.plain) {
			if (samp.plain.temperature !== undefined) {
				next.sampling.plain.temperature = clampNumber(
					samp.plain.temperature,
					next.sampling.plain.temperature,
					0,
					2
				);
			}
			if (samp.plain.top_p !== undefined) {
				next.sampling.plain.top_p = clampNumber(samp.plain.top_p, next.sampling.plain.top_p, 0, 1);
			}
		}
	}
	if (patch.completion) {
		if (patch.completion.mutatingMaxTokens !== undefined) {
			next.completion.mutatingMaxTokens = Math.round(
				clampNumber(patch.completion.mutatingMaxTokens, next.completion.mutatingMaxTokens, 256, 65536)
			);
		}
		if (patch.completion.readOnlyMaxTokens !== undefined) {
			next.completion.readOnlyMaxTokens = Math.round(
				clampNumber(patch.completion.readOnlyMaxTokens, next.completion.readOnlyMaxTokens, 256, 65536)
			);
		}
	}
	if (patch.toolTransport === 'native' || patch.toolTransport === 'text') {
		next.toolTransport = patch.toolTransport;
	} else if (patch.toolTransport === '') {
		delete next.toolTransport;
	}
	return next;
}

export type ToolTransport = 'native' | 'text';

export type ModelProfile = {
	version: 1;
	serverId: string;
	model: string;
	sampling: {
		plan: { temperature: number; top_p: number };
		/** Tool rounds with thinking off (the name predates `toolReasoning`). */
		toolThinking: { temperature: number; top_p: number; presence_penalty: number };
		/** Tool rounds with `thinking.toolRounds` on. Defaults to the tool sampling. */
		toolReasoning: { temperature: number; top_p: number; presence_penalty: number };
		plain: { temperature: number; top_p: number };
	};
	completion: { mutatingMaxTokens: number; readOnlyMaxTokens: number };
	thinking: {
		/**
		 * Server returned separate reasoning for an `enable_thinking` tool round (calibrate probe).
		 * Unset → name heuristic in `llmThinking.modelLikelySupportsThinking`.
		 */
		supported?: boolean;
		/**
		 * Reason before each tool call on Agent rounds. Off sends `enable_thinking: false` +
		 * `/no_think`, so the model takes the first plausible action. Set by calibrate A/B.
		 */
		toolRounds: boolean;
		/**
		 * After a structural stumble (guardrail, oracle red, edit miss, loop), the next
		 * round thinks once. Independent of toolRounds (always-on).
		 */
		escalate: boolean;
		/** Cap escalated thinking rounds per turn. */
		maxEscalationsPerTurn: number;
		/** Completion cap for tool rounds with thinking on (reasoning + tool arguments). */
		maxTokens: number;
	};
	mutations: {
		/** 0 = no cap. Default 180 on weak write gate. */
		writeMaxContentLines: number;
		largeFileExistingLines: number;
		enforceMassRewriteGate: boolean;
	};
	loop: {
		/**
		 * Consecutive steps of identical tool call + result before the stuck-wrap fires.
		 * Default 3 (unchanged). Calibrate-only experiment knob — raising it lets a weak
		 * model re-read a file a couple more times before the turn is forced to stop.
		 */
		stallThreshold: number;
	};
	finish: {
		maxDiagFinishNudges: number;
		specSelfCheckMaxNudges: number;
		specSelfCheckEnabled: boolean;
		/**
		 * Plano B: tools that count as an effect for the diagnose-only finish gate.
		 * Default is the set the gate used when the list lived in code.
		 */
		effectfulTools: string[];
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
	toolTransport?: ToolTransport;
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
		/** Contract fingerprint when this calibration was measured. */
		contract?: string;
		/** True when the live contract no longer matches `contract`. */
		stale?: boolean;
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
			toolReasoning: { temperature: 0.7, top_p: 0.8, presence_penalty: 0 },
			plain: { temperature: 0.2, top_p: 1 },
		},
		completion: { mutatingMaxTokens: 6144, readOnlyMaxTokens: 3072 },
		thinking: {
			toolRounds: false,
			escalate: true,
			maxEscalationsPerTurn: 6,
			maxTokens: 12288,
		},
		mutations: {
			writeMaxContentLines: 180,
			largeFileExistingLines: 60,
			enforceMassRewriteGate: true,
		},
		loop: {
			stallThreshold: 3,
		},
		finish: {
			maxDiagFinishNudges: 2,
			specSelfCheckMaxNudges: 1,
			specSelfCheckEnabled: true,
			effectfulTools: [...EFFECTFUL_TOOLS],
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
	const withServer = (slice: ModelProfile['sampling']['toolThinking']) => {
		const out = { ...slice };
		if (typeof serverSampling.temperature === 'number') out.temperature = serverSampling.temperature;
		if (typeof serverSampling.top_p === 'number') out.top_p = serverSampling.top_p;
		if (typeof serverSampling.presence_penalty === 'number') {
			out.presence_penalty = serverSampling.presence_penalty;
		}
		return out;
	};
	patch.sampling = {
		...profile.sampling,
		toolThinking: withServer(profile.sampling.toolThinking),
		toolReasoning: withServer(profile.sampling.toolReasoning),
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

export type CalibrationArm = { passes: number; runs: number; meanScore: number };

/**
 * @deprecated Prefer decideCandidate from candidateGate (stratified bootstrap).
 * Kept as a thin wrapper for callers that only have aggregate pass/mean stats.
 */
export function candidateArmWins(baseline: CalibrationArm, candidate: CalibrationArm): boolean {
	if (baseline.runs < 1 || candidate.runs < 1) return false;
	// Aggregate-only path: require a clear pass-rate gain; mean-only ties never win.
	const passBase = baseline.passes / baseline.runs;
	const passCand = candidate.passes / candidate.runs;
	if (passCand > passBase) return true;
	return false;
}

/** Fewest reps per task before calibrate may measure another tool transport. */
export const MIN_REPS_FOR_TRANSPORT_CHANGE = 3;

/**
 * Transport worth measuring against the current one, or undefined when protocol stats give no
 * reason to try. Calibrate runs the candidate and keeps it only if `candidateArmWins`.
 * One rep per task is noise (a single leaky cell can dominate the rate), so it never proposes.
 */
export function candidateToolTransport(input: {
	reps: number;
	current: ToolTransport;
	classification: CalibrationClass;
	badArgsRate: number;
	refusalRate: number;
}): ToolTransport | undefined {
	if (input.reps < MIN_REPS_FOR_TRANSPORT_CHANGE) return undefined;
	let proposed: ToolTransport | undefined;
	if (input.badArgsRate >= 0.1 || input.refusalRate >= 0.1) proposed = 'text';
	else if (input.classification === 'strong' && input.badArgsRate < 0.05) proposed = 'native';
	return proposed && proposed !== input.current ? proposed : undefined;
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
