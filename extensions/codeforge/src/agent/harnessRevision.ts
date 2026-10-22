/**
 * Test-time harness revision (Harness Learning).
 * A proposer persona edits a bounded artifact. The artifact is kept only when
 * repeated benchmark scores beat the parent by a margin. Oracle, tests, and
 * guard code are not editable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { modelProfileDir } from '../storage/paths';
import { mergeModelProfile, type ModelProfile } from './modelProfile';
import {
	emptyProtocolCounters,
	PROTOCOL_COUNTER_KEYS,
	type ProtocolRollup,
} from './protocolTelemetry';

export const HARNESS_SECTIONS = ['workflow', 'writePolicy', 'toolContract'] as const;
export type HarnessSection = (typeof HARNESS_SECTIONS)[number];

export const SECTION_MAX_CHARS = 1200;
export const DEFAULT_MIN_REPS = 3;
export const DEFAULT_MIN_DELTA = 2;
export const DEFAULT_TASK_REGRESSION = 2;
export const DEFAULT_BOOTSTRAP_SAMPLES = 2000;

const KNOB_LIMITS = {
	writeMaxContentLines: { min: 40, max: 400 },
	mutatingMaxTokens: { min: 1024, max: 8192 },
} as const;

/** Artifact text must not smuggle phrase matchers or a license to skip checks. */
const FORBIDDEN_SNIPPETS = [
	'harness note',
	'if the user says',
	'if the user asks',
	'when the user says',
	'when the user asks',
	'phrase match',
	'ignore the oracle',
	'disregard the oracle',
	'skip tests',
	'skip the tests',
	'ignore tests',
];

export type HarnessKnobs = {
	writeMaxContentLines?: number;
	mutatingMaxTokens?: number;
	enforceMassRewriteGate?: boolean;
};

export type HarnessHistoryEntry = {
	at: string;
	decision: 'keep' | 'revert';
	reason: string;
	diagnosis: string;
	parentMean?: number;
	candidateMean?: number;
	parentReps: number;
	candidateReps: number;
};

export type HarnessArtifact = {
	version: 1;
	revision: number;
	sections: Record<HarnessSection, string>;
	knobs: HarnessKnobs;
	history: HarnessHistoryEntry[];
};

export type HarnessEdit = {
	diagnosis: string;
	sections: Partial<Record<HarnessSection, string>>;
	knobs: HarnessKnobs;
};

export function emptyHarnessArtifact(): HarnessArtifact {
	return {
		version: 1,
		revision: 0,
		sections: { workflow: '', writePolicy: '', toolContract: '' },
		knobs: {},
		history: [],
	};
}

export function harnessFilePath(serverId: string, model: string, dir?: string): string {
	return path.join(dir ?? modelProfileDir(serverId, model), 'harness.json');
}

export function loadHarnessArtifact(
	serverId: string,
	model: string,
	filePath?: string
): HarnessArtifact {
	const fp = filePath ?? harnessFilePath(serverId, model);
	if (!fs.existsSync(fp)) return emptyHarnessArtifact();
	try {
		const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<HarnessArtifact>;
		return normalizeArtifact(raw);
	} catch {
		return emptyHarnessArtifact();
	}
}

export function saveHarnessArtifact(artifact: HarnessArtifact, filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf8');
}

function normalizeArtifact(raw: Partial<HarnessArtifact>): HarnessArtifact {
	const base = emptyHarnessArtifact();
	const sections = { ...base.sections };
	for (const key of HARNESS_SECTIONS) {
		const value = raw.sections?.[key];
		let body = typeof value === 'string' ? value.slice(0, SECTION_MAX_CHARS) : '';
		if (body && forbiddenSnippet(body)) body = '';
		sections[key] = body;
	}
	return {
		version: 1,
		revision: Number(raw.revision) || 0,
		sections,
		knobs: sanitizeKnobs(raw.knobs ?? {}),
		history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
	};
}

function sanitizeKnobs(raw: HarnessKnobs): HarnessKnobs {
	const out: HarnessKnobs = {};
	if (inRange(raw.writeMaxContentLines, KNOB_LIMITS.writeMaxContentLines)) {
		out.writeMaxContentLines = Math.round(raw.writeMaxContentLines as number);
	}
	if (inRange(raw.mutatingMaxTokens, KNOB_LIMITS.mutatingMaxTokens)) {
		out.mutatingMaxTokens = Math.round(raw.mutatingMaxTokens as number);
	}
	if (raw.enforceMassRewriteGate === true) {
		out.enforceMassRewriteGate = true;
	}
	return out;
}

function inRange(value: unknown, lim: { min: number; max: number }): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= lim.min && value <= lim.max;
}

export function artifactHasContent(artifact: HarnessArtifact): boolean {
	return (
		HARNESS_SECTIONS.some(k => artifact.sections[k].trim().length > 0) ||
		Object.keys(artifact.knobs).length > 0
	);
}

/** System block injected for this model. Empty when nothing has been kept. */
export function learnedHarnessBlock(artifact: HarnessArtifact): string {
	const parts: string[] = [];
	if (artifact.sections.workflow.trim()) {
		parts.push(`#### Workflow\n${artifact.sections.workflow.trim()}`);
	}
	if (artifact.sections.writePolicy.trim()) {
		parts.push(`#### Write policy\n${artifact.sections.writePolicy.trim()}`);
	}
	if (artifact.sections.toolContract.trim()) {
		parts.push(`#### Tool contract notes\n${artifact.sections.toolContract.trim()}`);
	}
	if (!parts.length) return '';
	return [
		'### Learned harness',
		'Kept for this model because repeated benchmark scores improved. Follow these notes together with the tool contract above. They do not override the oracle or mutation guards.',
		...parts,
	].join('\n\n');
}

export function applyHarnessKnobs(profile: ModelProfile, artifact: HarnessArtifact): ModelProfile {
	const knobs = artifact.knobs;
	if (!Object.keys(knobs).length) return profile;
	const patch: Partial<ModelProfile> = {};
	if (knobs.writeMaxContentLines !== undefined || knobs.enforceMassRewriteGate !== undefined) {
		patch.mutations = {
			...profile.mutations,
			...(knobs.writeMaxContentLines !== undefined
				? { writeMaxContentLines: knobs.writeMaxContentLines }
				: {}),
			...(knobs.enforceMassRewriteGate !== undefined
				? { enforceMassRewriteGate: knobs.enforceMassRewriteGate }
				: {}),
		};
	}
	if (knobs.mutatingMaxTokens !== undefined) {
		patch.completion = {
			...profile.completion,
			mutatingMaxTokens: knobs.mutatingMaxTokens,
		};
	}
	return mergeModelProfile(profile, patch);
}

export function formatExecutionReport(rollup: ProtocolRollup | undefined): string {
	if (!rollup || !rollup.runCount) {
		return 'No protocol rollup for this model yet.';
	}
	const runs = rollup.recent ?? [];
	if (!runs.length) {
		return 'No recent protocol runs for this model yet.';
	}
	const n = runs.length;
	const sums = emptyProtocolCounters();
	for (const r of runs) {
		for (const key of PROTOCOL_COUNTER_KEYS) {
			sums[key] += r.protocol[key] ?? 0;
		}
	}
	const native = sums.nativeToolCalls || 0;
	const badRate = native > 0 ? (sums.badArgs / native).toFixed(3) : 'n/a';
	const reasons = runs
		.flatMap(r => r.sampleReasons ?? [])
		.filter(Boolean)
		.slice(-8);
	const exits = runs
		.map(r => r.loopExit)
		.filter(Boolean)
		.slice(-8);
	return [
		`Protocol over ${n} recent runs (rollup total ${rollup.runCount}).`,
		`nativeToolCalls=${sums.nativeToolCalls} contentToolCalls=${sums.contentToolCalls} badArgs=${sums.badArgs} (badArgs/native=${badRate}) lengthExits=${sums.lengthExits} emptyReplies=${sums.emptyReplies} unknownTools=${sums.unknownTools}.`,
		exits.length ? `Recent loop exits: ${exits.join(', ')}.` : '',
		reasons.length ? `Recent failure samples: ${reasons.join('; ')}.` : '',
	]
		.filter(Boolean)
		.join('\n');
}

export type TaskOutcome = {
	task: string;
	score: number;
	loopExit?: string;
	steps?: number;
	hiddenFailed: string[];
	checksFailed: string[];
	replyTail?: string;
};

/** Per-run results of the current harness on the selection tasks. */
export function formatTaskOutcomes(outcomes: TaskOutcome[]): string {
	if (!outcomes.length) return '';
	const latestByTask = new Map<string, TaskOutcome>();
	for (const o of outcomes) latestByTask.set(o.task, o);
	const lines = [...latestByTask.values()].map(o => {
		const parts = [`- ${o.task}: score ${o.score}/100`];
		if (o.loopExit) parts.push(`loop exit ${o.loopExit}`);
		if (typeof o.steps === 'number' && o.loopExit !== 'budget') {
			parts.push(`${o.steps} tool steps`);
		}
		let line = parts.join(', ');
		if (o.hiddenFailed.length) line += `\n  hidden tests failed: ${o.hiddenFailed.slice(0, 6).join('; ')}`;
		if (o.checksFailed.length) line += `\n  checks failed: ${o.checksFailed.slice(0, 4).join('; ')}`;
		if (o.replyTail?.trim()) {
			line += `\n  final reply (clipped): ${o.replyTail.trim().replace(/\s+/g, ' ').slice(0, 280)}`;
		}
		return line;
	});
	return ['Current harness on the selection tasks:', ...lines].join('\n');
}

export function proposerMessages(
	artifact: HarnessArtifact,
	report: string
): Array<{ role: 'system' | 'user'; content: string }> {
	const prior = artifact.history
		.slice(-5)
		.map(h => `- ${h.decision}: ${h.diagnosis} (${h.reason})`)
		.join('\n');
	return [
		{
			role: 'system',
			content: [
				'You are the harness proposer for CodeForge. You do not solve the user task.',
				'You revise the executable notes and a few knobs that wrap a frozen solver.',
				'Reply with one JSON object and nothing else. No markdown fences, no tool calls.',
				'Schema: {"diagnosis":"...","sections":{"workflow":"","writePolicy":"","toolContract":""},"knobs":{"writeMaxContentLines":180,"mutatingMaxTokens":6144,"enforceMassRewriteGate":true}}',
				'Diagnose from the per-task results first (hidden test failures, loop exits, final replies). Protocol counters are secondary.',
				'Change only the sections or knobs that the execution report supports. Omit unchanged knobs.',
				`Each section is at most ${SECTION_MAX_CHARS} characters and states a structural rule (what to read, what a step must return, how to split a large write).`,
				'Do not add phrase matchers, "if the user says", or instructions to ignore the oracle or skip tests.',
				'If the report has no repeated failure, return {"diagnosis":"no evidence","sections":{},"knobs":{}}.',
			].join('\n'),
		},
		{
			role: 'user',
			content: [
				'Current harness artifact:',
				JSON.stringify({ revision: artifact.revision, sections: artifact.sections, knobs: artifact.knobs }),
				prior ? `Earlier revision outcomes:\n${prior}` : 'No earlier revision outcomes.',
				'Execution report:',
				report,
			].join('\n\n'),
		},
	];
}

/** Pull the proposer object out of prose, fences, or a leading think block. */
export function extractProposerJson(raw: string): unknown | undefined {
	const text = String(raw ?? '')
		.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
		.replace(/```(?:json)?/gi, '');
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '{') continue;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let j = i; j < text.length; j++) {
			const c = text[j];
			if (inStr) {
				if (esc) {
					esc = false;
					continue;
				}
				if (c === '\\') {
					esc = true;
					continue;
				}
				if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') {
				inStr = true;
				continue;
			}
			if (c === '{') depth += 1;
			else if (c === '}') {
				depth -= 1;
				if (depth === 0) {
					try {
						const value = JSON.parse(text.slice(i, j + 1)) as unknown;
						if (
							value &&
							typeof value === 'object' &&
							!Array.isArray(value) &&
							'diagnosis' in value
						) {
							return value;
						}
					} catch {
						/* try a later object */
					}
					break;
				}
			}
		}
	}
	return undefined;
}

export function parseProposerEdit(raw: string): { ok: true; edit: HarnessEdit } | { ok: false; error: string } {
	const parsed = extractProposerJson(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: 'proposer did not return a JSON object' };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: 'proposer JSON must be an object' };
	}
	const obj = parsed as Record<string, unknown>;
	const diagnosis = String(obj.diagnosis ?? '').trim();
	if (!diagnosis) return { ok: false, error: 'diagnosis is required' };
	if (diagnosis.toLowerCase() === 'no evidence') {
		return { ok: false, error: 'no evidence' };
	}
	const sections: Partial<Record<HarnessSection, string>> = {};
	const rawSections = obj.sections;
	if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
		const nested = (rawSections as Record<string, unknown>).knobs;
		if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
			obj.knobs = {
				...((obj.knobs && typeof obj.knobs === 'object' && !Array.isArray(obj.knobs)
					? obj.knobs
					: {}) as Record<string, unknown>),
				...(nested as Record<string, unknown>),
			};
			delete (rawSections as Record<string, unknown>).knobs;
		}
	}
	if (rawSections !== undefined) {
		if (!rawSections || typeof rawSections !== 'object' || Array.isArray(rawSections)) {
			return { ok: false, error: 'sections must be an object' };
		}
		for (const [key, value] of Object.entries(rawSections as Record<string, unknown>)) {
			if (!(HARNESS_SECTIONS as readonly string[]).includes(key)) {
				return { ok: false, error: `unknown section ${key}` };
			}
			if (typeof value !== 'string') return { ok: false, error: `section ${key} must be a string` };
			const body = value.trim();
			if (!body) continue;
			if (body.length > SECTION_MAX_CHARS) {
				return { ok: false, error: `section ${key} exceeds ${SECTION_MAX_CHARS} chars` };
			}
			const banned = forbiddenSnippet(body);
			if (banned) return { ok: false, error: `section ${key} contains forbidden text (${banned})` };
			sections[key as HarnessSection] = body;
		}
	}
	const knobs = sanitizeKnobs((obj.knobs ?? {}) as HarnessKnobs);
	const rawKnobs = obj.knobs;
	if (rawKnobs && typeof rawKnobs === 'object' && !Array.isArray(rawKnobs)) {
		for (const key of Object.keys(rawKnobs as object)) {
			if (!(key in KNOB_LIMITS) && key !== 'enforceMassRewriteGate') {
				return { ok: false, error: `unknown knob ${key}` };
			}
			const supplied = (rawKnobs as Record<string, unknown>)[key];
			if (key === 'enforceMassRewriteGate' && supplied === false) {
				return { ok: false, error: 'knob enforceMassRewriteGate must stay true when set' };
			}
			if (supplied !== undefined && !(key in knobs)) {
				return { ok: false, error: `knob ${key} is out of range` };
			}
		}
	}
	if (!Object.keys(sections).length && !Object.keys(knobs).length) {
		return { ok: false, error: 'no change' };
	}
	return { ok: true, edit: { diagnosis, sections, knobs } };
}

function normalizeForbiddenText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function forbiddenSnippet(text: string): string | undefined {
	const lower = normalizeForbiddenText(text);
	return FORBIDDEN_SNIPPETS.find(s => lower.includes(s));
}

export function applyHarnessEdit(parent: HarnessArtifact, edit: HarnessEdit): HarnessArtifact {
	const sections = { ...parent.sections };
	for (const key of HARNESS_SECTIONS) {
		if (edit.sections[key] !== undefined) sections[key] = edit.sections[key] as string;
	}
	return {
		version: 1,
		revision: parent.revision + 1,
		sections,
		knobs: { ...parent.knobs, ...edit.knobs },
		history: parent.history.slice(),
	};
}

export function meanScore(scores: number[]): number {
	if (!scores.length) return Number.NaN;
	return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export type TaskPairedScores = Record<string, { parent: number[]; candidate: number[] }>;

/** 90% one-sided lower bound on the mean paired gain (10th percentile of bootstrap means). */
export function bootstrapMeanLowerBound(
	deltas: number[],
	samples = DEFAULT_BOOTSTRAP_SAMPLES,
	quantile = 0.1,
	seed = 0xcf052026
): number {
	if (!deltas.length) return Number.NaN;
	const n = deltas.length;
	const means: number[] = [];
	let state = seed >>> 0;
	const rand = () => {
		state = (Math.imul(1664525, state) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	for (let b = 0; b < samples; b += 1) {
		let sum = 0;
		for (let i = 0; i < n; i += 1) {
			sum += deltas[Math.floor(rand() * n)]!;
		}
		means.push(sum / n);
	}
	means.sort((a, b) => a - b);
	const idx = Math.min(means.length - 1, Math.max(0, Math.floor(quantile * means.length)));
	return means[idx]!;
}

function flattenPaired(byTask: TaskPairedScores, side: 'parent' | 'candidate'): number[] {
	return Object.values(byTask).flatMap(p => p[side].filter(n => Number.isFinite(n)));
}

/**
 * Keep a revision only when every task has enough paired reps, no task regresses
 * beyond the margin, and each task's paired bootstrap 90% lower bound is > 0.
 */
export function decideRevision(input: {
	byTask: TaskPairedScores;
	minRepsPerTask?: number;
	taskRegressionMargin?: number;
	bootstrapSamples?: number;
}): { decision: 'keep' | 'revert'; reason: string; parentMean: number; candidateMean: number } {
	const minReps = input.minRepsPerTask ?? DEFAULT_MIN_REPS;
	const margin = input.taskRegressionMargin ?? DEFAULT_TASK_REGRESSION;
	const samples = input.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
	const tasks = Object.keys(input.byTask);
	if (!tasks.length) {
		return {
			decision: 'revert',
			reason: 'no paired task scores',
			parentMean: Number.NaN,
			candidateMean: Number.NaN,
		};
	}
	for (const task of tasks) {
		const pair = input.byTask[task]!;
		const parent = pair.parent.filter(n => Number.isFinite(n));
		const candidate = pair.candidate.filter(n => Number.isFinite(n));
		if (parent.length < minReps || candidate.length < minReps) {
			return {
				decision: 'revert',
				reason: `${task}: need ${minReps} paired scores (parent ${parent.length}, candidate ${candidate.length})`,
				parentMean: meanScore(flattenPaired(input.byTask, 'parent')),
				candidateMean: meanScore(flattenPaired(input.byTask, 'candidate')),
			};
		}
		if (parent.length !== candidate.length) {
			return {
				decision: 'revert',
				reason: `${task}: paired score count mismatch (${parent.length} vs ${candidate.length})`,
				parentMean: meanScore(flattenPaired(input.byTask, 'parent')),
				candidateMean: meanScore(flattenPaired(input.byTask, 'candidate')),
			};
		}
		const parentMean = meanScore(parent);
		const candidateMean = meanScore(candidate);
		if (candidateMean < parentMean - margin) {
			return {
				decision: 'revert',
				reason: `${task}: candidate mean ${candidateMean.toFixed(1)} is more than ${margin} below parent ${parentMean.toFixed(1)}`,
				parentMean: meanScore(flattenPaired(input.byTask, 'parent')),
				candidateMean: meanScore(flattenPaired(input.byTask, 'candidate')),
			};
		}
		const deltas = candidate.map((c, i) => c - parent[i]!);
		const lower = bootstrapMeanLowerBound(deltas, samples);
		if (!(lower > 0)) {
			return {
				decision: 'revert',
				reason: `${task}: paired bootstrap 90% lower bound ${lower.toFixed(2)} is not > 0`,
				parentMean: meanScore(flattenPaired(input.byTask, 'parent')),
				candidateMean: meanScore(flattenPaired(input.byTask, 'candidate')),
			};
		}
	}
	const parentMean = meanScore(flattenPaired(input.byTask, 'parent'));
	const candidateMean = meanScore(flattenPaired(input.byTask, 'candidate'));
	return {
		decision: 'keep',
		reason: `all ${tasks.length} task(s) cleared paired bootstrap with no regression beyond ${margin}`,
		parentMean,
		candidateMean,
	};
}

/** True when held-out CS tasks drop versus the parent under the same margin. */
export function holdoutRegressed(
	parent: TaskPairedScores,
	candidate: TaskPairedScores,
	margin = DEFAULT_TASK_REGRESSION
): string | undefined {
	for (const task of Object.keys(parent)) {
		const p = parent[task]?.parent.filter(n => Number.isFinite(n)) ?? [];
		const c = candidate[task]?.candidate.filter(n => Number.isFinite(n)) ?? [];
		if (!p.length || !c.length) continue;
		const parentMean = meanScore(p);
		const candidateMean = meanScore(c);
		if (candidateMean < parentMean - margin) {
			return `${task}: holdout mean ${candidateMean.toFixed(1)} dropped below parent ${parentMean.toFixed(1)}`;
		}
	}
	return undefined;
}

export type HarnessRevisionOutcome = {
	kept: boolean;
	reason: string;
	diagnosis: string;
	artifact: HarnessArtifact;
	parentMean?: number;
	candidateMean?: number;
	scored: boolean;
};

/**
 * The parent is scored first so the proposer sees its per-task results; a
 * proposal written from protocol counters alone cannot target task failures.
 */
export type HarnessScorePhase =
	| { phase: 'parent'; artifact: HarnessArtifact }
	| { phase: 'paired'; parent: HarnessArtifact; candidate: HarnessArtifact };

export type HarnessScoreResult = {
	byTask: TaskPairedScores;
};

export async function executeHarnessRevision(opts: {
	artifact: HarnessArtifact;
	report: string;
	propose: (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>;
	score: (input: HarnessScorePhase) => Promise<HarnessScoreResult>;
	/** Per-task results gathered while scoring the parent. */
	parentOutcomes?: () => TaskOutcome[];
	minRepsPerTask?: number;
	taskRegressionMargin?: number;
	now?: string;
}): Promise<HarnessRevisionOutcome> {
	await opts.score({ phase: 'parent', artifact: opts.artifact });
	const taskReport = formatTaskOutcomes(opts.parentOutcomes?.() ?? []);
	const report = [taskReport, opts.report].filter(Boolean).join('\n\n');
	const raw = await opts.propose(proposerMessages(opts.artifact, report));
	const parsed = parseProposerEdit(raw);
	if (!parsed.ok) {
		return {
			kept: false,
			reason: parsed.error,
			diagnosis: '',
			artifact: opts.artifact,
			scored: false,
		};
	}
	const candidate = applyHarnessEdit(opts.artifact, parsed.edit);
	const paired = await opts.score({ phase: 'paired', parent: opts.artifact, candidate });
	const decision = decideRevision({
		byTask: paired.byTask,
		minRepsPerTask: opts.minRepsPerTask,
		taskRegressionMargin: opts.taskRegressionMargin,
	});
	const parentReps = Object.values(paired.byTask).reduce((s, p) => s + p.parent.length, 0);
	const candidateReps = Object.values(paired.byTask).reduce((s, p) => s + p.candidate.length, 0);
	const entry: HarnessHistoryEntry = {
		at: opts.now ?? new Date().toISOString(),
		decision: decision.decision,
		reason: decision.reason,
		diagnosis: parsed.edit.diagnosis,
		parentMean: decision.parentMean,
		candidateMean: decision.candidateMean,
		parentReps,
		candidateReps,
	};
	const base = decision.decision === 'keep' ? candidate : opts.artifact;
	const artifact: HarnessArtifact = {
		...base,
		history: [...base.history, entry].slice(-20),
	};
	return {
		kept: decision.decision === 'keep',
		reason: decision.reason,
		diagnosis: parsed.edit.diagnosis,
		artifact,
		parentMean: decision.parentMean,
		candidateMean: decision.candidateMean,
		scored: true,
	};
}
