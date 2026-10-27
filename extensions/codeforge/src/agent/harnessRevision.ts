/**
 * Test-time harness revision (Harness Learning).
 * A proposer persona edits a bounded artifact. The artifact is kept only when
 * repeated benchmark scores beat the parent by a margin. Oracle, tests, and
 * guard code are not editable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { modelProfileDir } from '../storage/paths';
import {
	DEFAULT_BOOTSTRAP_SAMPLES,
	DEFAULT_MIN_REPS,
	DEFAULT_TASK_REGRESSION,
	decideCandidate,
	meanScore,
	bootstrapMeanLowerBound,
} from './candidateGate';
import { firstMatchingToken } from './fixtureIdentifiers';
import { mergeModelProfile, type ModelProfile } from './modelProfile';
import {
	emptyProtocolCounters,
	PROTOCOL_COUNTER_KEYS,
	type ProtocolRollup,
} from './protocolTelemetry';

export { DEFAULT_MIN_REPS, DEFAULT_TASK_REGRESSION, DEFAULT_BOOTSTRAP_SAMPLES, meanScore, bootstrapMeanLowerBound };

export const HARNESS_SECTIONS = ['workflow', 'writePolicy', 'toolContract'] as const;
export type HarnessSection = (typeof HARNESS_SECTIONS)[number];

export const SECTION_MAX_CHARS = 1200;
export const DEFAULT_MIN_DELTA = 2;

const KNOB_LIMITS = {
	writeMaxContentLines: { min: 40, max: 400 },
	mutatingMaxTokens: { min: 1024, max: 8192 },
} as const;

/** Artifact text must not smuggle phrase matchers or a license to skip checks. */
export const FORBIDDEN_SNIPPETS = [
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

export type HarnessScreen = {
	tokenCount: number;
	at: string;
};

export type HarnessArtifact = {
	version: 1;
	revision: number;
	sections: Record<HarnessSection, string>;
	knobs: HarnessKnobs;
	history: HarnessHistoryEntry[];
	/**
	 * Set when a revision was kept after fixture-token screening.
	 * Absent on legacy artifacts → treated as empty at load (quarantine).
	 */
	screen?: HarnessScreen;
	/** Contract fingerprint the revision was measured against (F2). */
	contract?: string;
};

export type SectionEvidence = { run: string; step: number };

export type HarnessEdit = {
	diagnosis: string;
	sections: Partial<Record<HarnessSection, string>>;
	knobs: HarnessKnobs;
	/** Per non-empty section: trajectory moments that justify the text. */
	evidence?: Partial<Record<HarnessSection, SectionEvidence[]>>;
};

export type ParseProposerOpts = {
	forbiddenTokens?: string[];
	/** Known run labels → max tool step index (1-based) in that run's log. */
	knownRuns?: Record<string, number>;
	/** Require evidence citations for non-empty sections (default true when knownRuns set). */
	requireEvidence?: boolean;
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
	const screen = parseScreen(raw.screen);
	const hasBody =
		HARNESS_SECTIONS.some(k => sections[k].trim().length > 0) ||
		Object.keys(sanitizeKnobs(raw.knobs ?? {})).length > 0;
	// Legacy artifacts without a screen stamp are quarantined: not injected.
	if (hasBody && !screen) {
		return {
			...base,
			revision: Number(raw.revision) || 0,
			history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
			...(typeof raw.contract === 'string' && raw.contract ? { contract: raw.contract } : {}),
		};
	}
	return {
		version: 1,
		revision: Number(raw.revision) || 0,
		sections,
		knobs: sanitizeKnobs(raw.knobs ?? {}),
		history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
		...(screen ? { screen } : {}),
		...(typeof raw.contract === 'string' && raw.contract ? { contract: raw.contract } : {}),
	};
}

function parseScreen(raw: unknown): HarnessScreen | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	const tokenCount = Number(o.tokenCount);
	const at = typeof o.at === 'string' ? o.at : '';
	if (!Number.isFinite(tokenCount) || tokenCount < 0 || !at) return undefined;
	return { tokenCount: Math.round(tokenCount), at };
}

/** Stamp a kept artifact after fixture-token screening. */
export function stampScreen(
	artifact: HarnessArtifact,
	tokenCount: number,
	at?: string
): HarnessArtifact {
	return {
		...artifact,
		screen: {
			tokenCount: Math.max(0, Math.round(tokenCount)),
			at: at ?? new Date().toISOString(),
		},
	};
}

/** First fixture token found in any section body, if any. */
export function artifactFixtureHit(
	artifact: HarnessArtifact,
	tokens: string[]
): string | undefined {
	for (const key of HARNESS_SECTIONS) {
		const hit = firstMatchingToken(artifact.sections[key], tokens);
		if (hit) return hit;
	}
	return undefined;
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

/**
 * System block injected for this model. Empty when nothing has been kept or screened,
 * or when the artifact's contract no longer matches the live harness contract.
 */
export function learnedHarnessBlock(
	artifact: HarnessArtifact,
	liveContract?: string
): string {
	if (!artifact.screen) return '';
	if (
		liveContract &&
		artifact.contract &&
		artifact.contract !== liveContract
	) {
		return '';
	}
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
	/** Kept for the decision gate only — never shown to the proposer. */
	score: number;
	loopExit?: string;
	steps?: number;
	/** Kept for the decision gate only — never shown to the proposer. */
	hiddenFailed: string[];
	checksFailed: string[];
	replyTail?: string;
	/** Full tool trajectory for this run (proposer evidence). */
	toolLog?: string;
	/** Visible (non-hidden) test output only. */
	visibleOutput?: string;
	/** Stable run label for evidence citations, e.g. T2-r1. */
	runId?: string;
};

/**
 * Proposer-facing report: trajectories, visible output, loop exits.
 * Scores and hidden-test names stay out (Harness² answer-free boundary).
 */
export function formatTaskOutcomes(outcomes: TaskOutcome[]): string {
	if (!outcomes.length) return '';
	const lines: string[] = ['Current harness on the selection tasks (no scores; judge from trajectories):'];
	for (const o of outcomes) {
		const run = o.runId || o.task;
		const parts = [`### Run ${run}`];
		if (o.loopExit) parts.push(`loop exit ${o.loopExit}`);
		if (typeof o.steps === 'number' && o.loopExit !== 'budget') {
			parts.push(`${o.steps} tool steps`);
		}
		lines.push(parts.join(', '));
		if (o.toolLog?.trim()) {
			lines.push('Trajectory:');
			lines.push(o.toolLog.trim().slice(0, 12000));
		}
		if (o.visibleOutput?.trim()) {
			lines.push('Visible test output:');
			lines.push(o.visibleOutput.trim().slice(0, 4000));
		}
		if (o.replyTail?.trim()) {
			lines.push(`Final reply (clipped): ${o.replyTail.trim().replace(/\s+/g, ' ').slice(0, 280)}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * Refuse a proposer report that still contains grader verdicts (hidden names or scores).
 * Tripwire on the boundary — primary defence is formatTaskOutcomes.
 */
export function assertNoGraderVerdicts(
	report: string,
	hiddenNames: string[]
): string | undefined {
	const text = String(report ?? '');
	if (/\bscore\s+\d+\/100\b/i.test(text) || /\bhidden tests failed\b/i.test(text)) {
		return 'report contains grader verdict fields';
	}
	for (const name of hiddenNames) {
		const n = String(name ?? '').trim();
		if (n.length < 3) continue;
		if (text.includes(n)) return `report contains hidden test name ${n}`;
	}
	return undefined;
}

export type ProposeDimension = 'all' | 'INV' | 'DOM';

const DIMENSION_SECTIONS: Record<ProposeDimension, HarnessSection[] | null> = {
	all: null,
	INV: ['workflow', 'toolContract'],
	DOM: ['writePolicy'],
};

export function proposerMessages(
	artifact: HarnessArtifact,
	report: string,
	dimension: ProposeDimension = 'all'
): Array<{ role: 'system' | 'user'; content: string }> {
	const prior = artifact.history
		.slice(-5)
		.map(h => `- ${h.decision}: ${h.diagnosis} (${h.reason})`)
		.join('\n');
	const allowed = DIMENSION_SECTIONS[dimension];
	const sectionHint =
		dimension === 'INV'
			? 'Edit only workflow and toolContract (procedure and tool use). Leave writePolicy empty or unchanged.'
			: dimension === 'DOM'
				? 'Edit only writePolicy (project knowledge / how to write). Leave workflow and toolContract empty or unchanged.'
				: 'You may edit any section.';
	return [
		{
			role: 'system',
			content: [
				'You are the harness proposer for CodeForge. You do not solve the user task.',
				'You revise the executable notes and a few knobs that wrap a frozen solver.',
				'Reply with one JSON object and nothing else. No markdown fences, no tool calls.',
				'Schema: {"diagnosis":"...","sections":{"workflow":"","writePolicy":"","toolContract":""},"evidence":{"workflow":[{"run":"T2-r1","step":3}],"writePolicy":[{"run":"T2-r1","step":5}]},"knobs":{"writeMaxContentLines":180,"mutatingMaxTokens":6144,"enforceMassRewriteGate":true}}',
				sectionHint,
				'Diagnose from trajectories, loop exits, visible test output, and final replies. You do not receive scores or hidden-test names.',
				'Prioritize where replicates DIVERGED (same task, different actions) and failures that repeated across every replicate. A failure in 1 of 3 replicates is noise.',
				'Every non-empty section must cite evidence: [{run, step}] pointing at a trajectory moment. An edit without a named moment is speculation.',
				'Change only the sections or knobs that the execution report supports. Omit unchanged knobs.',
				`Each section is at most ${SECTION_MAX_CHARS} characters and states a structural rule (what to read, what a step must return, how to split a large write).`,
				'Do not add phrase matchers, "if the user says", task-specific function or path names from the fixture, or instructions to ignore the oracle or skip tests.',
				'If the report has no repeated failure, return {"diagnosis":"no evidence","sections":{},"knobs":{}}.',
			].join('\n'),
		},
		{
			role: 'user',
			content: [
				'Current harness artifact:',
				JSON.stringify({ revision: artifact.revision, sections: artifact.sections, knobs: artifact.knobs }),
				prior ? `Earlier revision outcomes:\n${prior}` : 'No earlier revision outcomes.',
				allowed
					? `Allowed sections this call: ${allowed.join(', ')}.`
					: 'All sections allowed.',
				'Execution report:',
				report,
			].join('\n\n'),
		},
	];
}

export function composeMessages(input: {
	parent: HarnessArtifact;
	inv: HarnessArtifact;
	dom: HarnessArtifact;
	parentReport: string;
	invProbe: string;
	domProbe: string;
}): Array<{ role: 'system' | 'user'; content: string }> {
	return [
		{
			role: 'system',
			content: [
				'You compose harness candidates. Reply with one JSON object only.',
				'Schema: {"choice":"merge"|"inv"|"dom"|"KEEP_BASE","diagnosis":"...","sections":{"workflow":"","writePolicy":"","toolContract":""},"knobs":{}}',
				'merge: combine the best of INV (workflow/toolContract) and DOM (writePolicy).',
				'inv or dom: keep that candidate wholesale.',
				'KEEP_BASE: keep the parent unchanged (sections may be empty).',
				'Do not invent fixture-specific names or phrase matchers.',
			].join('\n'),
		},
		{
			role: 'user',
			content: [
				'Parent:',
				JSON.stringify({ sections: input.parent.sections, knobs: input.parent.knobs }),
				'INV candidate (procedure/tools):',
				JSON.stringify({ sections: input.inv.sections, knobs: input.inv.knobs }),
				'DOM candidate (write policy):',
				JSON.stringify({ sections: input.dom.sections, knobs: input.dom.knobs }),
				'Parent trajectories:',
				input.parentReport,
				'INV probe trajectory:',
				input.invProbe,
				'DOM probe trajectory:',
				input.domProbe,
			].join('\n\n'),
		},
	];
}

export function parseComposeChoice(
	raw: string
):
	| { ok: true; choice: 'merge' | 'inv' | 'dom' | 'KEEP_BASE'; edit: HarnessEdit }
	| { ok: false; error: string } {
	const parsed = extractProposerJson(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: 'no compose JSON' };
	}
	const obj = parsed as Record<string, unknown>;
	const choiceRaw = String(obj.choice || '').trim();
	const choice =
		choiceRaw === 'merge' || choiceRaw === 'inv' || choiceRaw === 'dom' || choiceRaw === 'KEEP_BASE'
			? choiceRaw
			: undefined;
	if (!choice) return { ok: false, error: 'choice must be merge|inv|dom|KEEP_BASE' };
	if (choice === 'KEEP_BASE') {
		return {
			ok: true,
			choice,
			edit: {
				diagnosis: String(obj.diagnosis || 'KEEP_BASE'),
				sections: {},
				knobs: {},
			},
		};
	}
	const editParsed = parseProposerEdit(raw, {});
	if (!editParsed.ok) return { ok: false, error: editParsed.error };
	return { ok: true, choice, edit: editParsed.edit };
}

/** Restrict an edit to the sections allowed for a propose dimension. */
export function filterEditToDimension(edit: HarnessEdit, dimension: ProposeDimension): HarnessEdit {
	const allowed = DIMENSION_SECTIONS[dimension];
	if (!allowed) return edit;
	const sections: Partial<Record<HarnessSection, string>> = {};
	for (const key of allowed) {
		if (edit.sections[key] !== undefined) sections[key] = edit.sections[key];
	}
	return { ...edit, sections };
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

export function parseProposerEdit(
	raw: string,
	opts: ParseProposerOpts = {}
): { ok: true; edit: HarnessEdit } | { ok: false; error: string } {
	const parsed = extractProposerJson(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: 'proposer did not return a JSON object' };
	}
	const obj = parsed as Record<string, unknown>;
	const diagnosis = String(obj.diagnosis ?? '').trim();
	if (!diagnosis) return { ok: false, error: 'diagnosis is required' };
	if (diagnosis.toLowerCase() === 'no evidence') {
		return { ok: false, error: 'no evidence' };
	}
	const forbidden = opts.forbiddenTokens ?? [];
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
			const fixtureHit = firstMatchingToken(body, forbidden);
			if (fixtureHit) {
				return {
					ok: false,
					error: `section ${key} contains fixture identifier (${fixtureHit})`,
				};
			}
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

	const requireEvidence =
		opts.requireEvidence === true ||
		(opts.requireEvidence !== false && !!opts.knownRuns && Object.keys(opts.knownRuns).length > 0);
	const evidence: Partial<Record<HarnessSection, SectionEvidence[]>> = {};
	const rawEvidence = obj.evidence;
	if (requireEvidence && Object.keys(sections).length) {
		if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
			return { ok: false, error: 'evidence is required for non-empty sections' };
		}
		for (const key of Object.keys(sections) as HarnessSection[]) {
			const rows = (rawEvidence as Record<string, unknown>)[key];
			if (!Array.isArray(rows) || !rows.length) {
				return { ok: false, error: `section ${key} needs evidence citations` };
			}
			const parsedRows: SectionEvidence[] = [];
			for (const row of rows) {
				if (!row || typeof row !== 'object' || Array.isArray(row)) {
					return { ok: false, error: `section ${key} evidence entry must be an object` };
				}
				const run = String((row as Record<string, unknown>).run ?? '').trim();
				const step = Number((row as Record<string, unknown>).step);
				if (!run || !Number.isFinite(step) || step < 1) {
					return { ok: false, error: `section ${key} evidence needs run and step >= 1` };
				}
				if (opts.knownRuns) {
					const max = opts.knownRuns[run];
					if (max === undefined) {
						return { ok: false, error: `section ${key} cites unknown run ${run}` };
					}
					if (step > max) {
						return {
							ok: false,
							error: `section ${key} cites step ${step} outside run ${run} (max ${max})`,
						};
					}
				}
				parsedRows.push({ run, step: Math.round(step) });
			}
			evidence[key] = parsedRows;
		}
	}

	return {
		ok: true,
		edit: {
			diagnosis,
			sections,
			knobs,
			...(Object.keys(evidence).length ? { evidence } : {}),
		},
	};
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
		...(parent.screen ? { screen: parent.screen } : {}),
		...(parent.contract ? { contract: parent.contract } : {}),
	};
}

export type TaskPairedScores = Record<string, { parent: number[]; candidate: number[] }>;

/**
 * Keep a revision only when the shared candidate gate clears: enough reps,
 * no task regression beyond the margin, and stratified bootstrap lower bound > 0.
 * Ceiling tasks (both sides at 100) never block.
 */
export function decideRevision(input: {
	byTask: TaskPairedScores;
	minRepsPerTask?: number;
	taskRegressionMargin?: number;
	bootstrapSamples?: number;
}): { decision: 'keep' | 'revert'; reason: string; parentMean: number; candidateMean: number } {
	const byTask: Record<string, { baseline: number[]; candidate: number[] }> = {};
	for (const [task, pair] of Object.entries(input.byTask)) {
		byTask[task] = { baseline: pair.parent, candidate: pair.candidate };
	}
	const d = decideCandidate({
		byTask,
		minRepsPerTask: input.minRepsPerTask,
		taskRegressionMargin: input.taskRegressionMargin,
		bootstrapSamples: input.bootstrapSamples,
	});
	return {
		decision: d.decision,
		reason: d.reason,
		parentMean: d.baselineMean,
		candidateMean: d.candidateMean,
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
	/** Proposer report still carried grader verdicts; nothing was proposed. */
	leak?: boolean;
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
	/** Fixture identifiers that must not appear in section text. */
	forbiddenTokens?: string[];
	/** Hidden-test names that must not appear in the proposer report. */
	hiddenNames?: string[];
	minRepsPerTask?: number;
	taskRegressionMargin?: number;
	now?: string;
	/** Optional contract fingerprint stamped on a kept revision (F2). */
	contract?: string;
	/**
	 * Propose–Probe–Compose: propose INV + DOM, one probe each, compose, then gate.
	 * When set, `scoreProbe` must return a short trajectory summary for the composer.
	 */
	ppc?: boolean;
	scoreProbe?: (input: {
		label: 'inv' | 'dom';
		artifact: HarnessArtifact;
	}) => Promise<{ summary: string }>;
}): Promise<HarnessRevisionOutcome> {
	await opts.score({ phase: 'parent', artifact: opts.artifact });
	const outcomes = opts.parentOutcomes?.() ?? [];
	const taskReport = formatTaskOutcomes(outcomes);
	const report = [taskReport, opts.report].filter(Boolean).join('\n\n');
	const leak = assertNoGraderVerdicts(report, opts.hiddenNames ?? []);
	if (leak) {
		return {
			kept: false,
			reason: leak,
			diagnosis: '',
			artifact: opts.artifact,
			scored: false,
			leak: true,
		};
	}

	const knownRuns: Record<string, number> = {};
	for (const o of outcomes) {
		const id = o.runId || o.task;
		const steps =
			typeof o.steps === 'number' && o.steps > 0
				? o.steps
				: Math.max(1, (o.toolLog || '').split(/\n/).filter(Boolean).length || 1);
		knownRuns[id] = Math.max(knownRuns[id] ?? 0, steps);
	}
	const parseOpts: ParseProposerOpts = {
		forbiddenTokens: opts.forbiddenTokens,
		knownRuns: Object.keys(knownRuns).length ? knownRuns : undefined,
	};

	const proposeOnce = async (dimension: ProposeDimension): Promise<
		{ ok: true; edit: HarnessEdit } | { ok: false; error: string }
	> => {
		let messages = proposerMessages(opts.artifact, report, dimension);
		let raw = await opts.propose(messages);
		let parsed = parseProposerEdit(raw, parseOpts);
		if (!parsed.ok && parsed.error !== 'no evidence') {
			messages = [
				...proposerMessages(opts.artifact, report, dimension),
				{
					role: 'user',
					content: `Your previous attempt was rejected: ${parsed.error}. Fix it and reply with one JSON object again.`,
				},
			];
			raw = await opts.propose(messages);
			parsed = parseProposerEdit(raw, parseOpts);
		}
		if (!parsed.ok) return parsed;
		return {
			ok: true,
			edit: filterEditToDimension(parsed.edit, dimension),
		};
	};

	let candidate: HarnessArtifact;
	let diagnosis: string;

	if (opts.ppc) {
		const invParsed = await proposeOnce('INV');
		const domParsed = await proposeOnce('DOM');
		if (!invParsed.ok && !domParsed.ok) {
			return {
				kept: false,
				reason: `INV: ${invParsed.error}; DOM: ${domParsed.error}`,
				diagnosis: '',
				artifact: opts.artifact,
				scored: false,
			};
		}
		const invArt = invParsed.ok
			? applyHarnessEdit(opts.artifact, invParsed.edit)
			: opts.artifact;
		const domArt = domParsed.ok
			? applyHarnessEdit(opts.artifact, domParsed.edit)
			: opts.artifact;
		const invProbe = opts.scoreProbe
			? await opts.scoreProbe({ label: 'inv', artifact: invArt })
			: { summary: '(no probe)' };
		const domProbe = opts.scoreProbe
			? await opts.scoreProbe({ label: 'dom', artifact: domArt })
			: { summary: '(no probe)' };
		const composeRaw = await opts.propose(
			composeMessages({
				parent: opts.artifact,
				inv: invArt,
				dom: domArt,
				parentReport: taskReport || report,
				invProbe: invProbe.summary,
				domProbe: domProbe.summary,
			})
		);
		const composed = parseComposeChoice(composeRaw);
		if (!composed.ok) {
			return {
				kept: false,
				reason: composed.error,
				diagnosis: '',
				artifact: opts.artifact,
				scored: false,
			};
		}
		if (composed.choice === 'KEEP_BASE') {
			const entry: HarnessHistoryEntry = {
				at: opts.now ?? new Date().toISOString(),
				decision: 'revert',
				reason: 'composer chose KEEP_BASE',
				diagnosis: composed.edit.diagnosis,
				parentReps: 0,
				candidateReps: 0,
			};
			return {
				kept: false,
				reason: entry.reason,
				diagnosis: composed.edit.diagnosis,
				artifact: {
					...opts.artifact,
					history: [...opts.artifact.history, entry].slice(-20),
				},
				scored: false,
			};
		}
		if (composed.choice === 'inv') {
			candidate = invArt;
			diagnosis = invParsed.ok ? invParsed.edit.diagnosis : composed.edit.diagnosis;
		} else if (composed.choice === 'dom') {
			candidate = domArt;
			diagnosis = domParsed.ok ? domParsed.edit.diagnosis : composed.edit.diagnosis;
		} else {
			const mergeEdit = filterEditToDimension(
				{
					...composed.edit,
					sections: {
						workflow:
							composed.edit.sections.workflow ??
							invArt.sections.workflow,
						toolContract:
							composed.edit.sections.toolContract ??
							invArt.sections.toolContract,
						writePolicy:
							composed.edit.sections.writePolicy ??
							domArt.sections.writePolicy,
					},
				},
				'all'
			);
			candidate = applyHarnessEdit(opts.artifact, mergeEdit);
			diagnosis = composed.edit.diagnosis;
		}
	} else {
		const parsed = await proposeOnce('all');
		if (!parsed.ok) {
			return {
				kept: false,
				reason: parsed.error,
				diagnosis: '',
				artifact: opts.artifact,
				scored: false,
			};
		}
		candidate = applyHarnessEdit(opts.artifact, parsed.edit);
		diagnosis = parsed.edit.diagnosis;
	}

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
		diagnosis,
		parentMean: decision.parentMean,
		candidateMean: decision.candidateMean,
		parentReps,
		candidateReps,
	};
	let base = decision.decision === 'keep' ? candidate : opts.artifact;
	if (decision.decision === 'keep') {
		base = stampScreen(base, opts.forbiddenTokens?.length ?? 0, entry.at);
		if (opts.contract) base = { ...base, contract: opts.contract };
	}
	const artifact: HarnessArtifact = {
		...base,
		history: [...base.history, entry].slice(-20),
	};
	return {
		kept: decision.decision === 'keep',
		reason: decision.reason,
		diagnosis,
		artifact,
		parentMean: decision.parentMean,
		candidateMean: decision.candidateMean,
		scored: true,
	};
}

/**
 * Artifact as written for a scored run. The agent quarantines unscreened artifacts
 * that have content, so an unstamped candidate would be scored as the empty harness.
 * Content with a fixture token is refused instead of stamped.
 */
export function screenForScoring(
	artifact: HarnessArtifact,
	forbiddenTokens: string[]
): { ok: true; artifact: HarnessArtifact } | { ok: false; reason: string } {
	if (!artifactHasContent(artifact) || artifact.screen) return { ok: true, artifact };
	const hit = artifactFixtureHit(artifact, forbiddenTokens);
	if (hit) return { ok: false, reason: `candidate contains fixture identifier ${hit}` };
	return { ok: true, artifact: stampScreen(artifact, forbiddenTokens.length) };
}

export type HarnessRevisionOpts = Parameters<typeof executeHarnessRevision>[0];

export type SequentialStepRecord = HarnessRevisionOutcome & {
	step: number;
	parentRevision: number;
};

/**
 * Sequential recursion: run `steps` revisions, each starting from the artifact the
 * previous step returned (the kept candidate, or the same parent with the revert in
 * its history so the next proposer sees why). A grader-verdict leak ends the loop.
 * `afterStep` may veto a keep (holdout) and must return the outcome to carry forward.
 */
export async function executeSequentialRevision(
	opts: Omit<HarnessRevisionOpts, 'artifact'> & {
		artifact: HarnessArtifact;
		steps: number;
		beforeStep?: (step: number, parent: HarnessArtifact) => void | Promise<void>;
		afterStep?: (
			step: number,
			outcome: HarnessRevisionOutcome,
			parent: HarnessArtifact
		) => HarnessRevisionOutcome | Promise<HarnessRevisionOutcome>;
	}
): Promise<{ final: HarnessArtifact; steps: SequentialStepRecord[] }> {
	const total = Math.max(1, Math.floor(opts.steps));
	const { steps: _steps, beforeStep, afterStep, ...base } = opts;
	let parent = opts.artifact;
	const records: SequentialStepRecord[] = [];
	for (let step = 1; step <= total; step++) {
		await beforeStep?.(step, parent);
		let outcome = await executeHarnessRevision({ ...base, artifact: parent });
		if (afterStep) outcome = await afterStep(step, outcome, parent);
		records.push({ ...outcome, step, parentRevision: parent.revision });
		if (outcome.leak) break;
		parent = outcome.artifact;
	}
	return { final: parent, steps: records };
}

export type TransferPrecheck =
	| { ok: true }
	| { ok: false; status: 'NotRun'; reason: string };

/** A learned artifact may be scored on another task set only if it has content and no target fixture tokens. */
export function transferPrecheck(
	artifact: HarnessArtifact,
	targetTokens: string[]
): TransferPrecheck {
	if (!artifactHasContent(artifact)) {
		return { ok: false, status: 'NotRun', reason: 'nothing to transfer: artifact has no kept sections or knobs' };
	}
	const hit = artifactFixtureHit(artifact, targetTokens);
	if (hit) {
		return {
			ok: false,
			status: 'NotRun',
			reason: `artifact contains target fixture identifier ${hit}`,
		};
	}
	return { ok: true };
}

/** Paired empty-vs-learned scores on the target set, decided by the same candidate gate. */
export function decideTransfer(byTask: Record<string, { empty: number[]; learned: number[] }>): {
	decision: 'keep' | 'revert';
	reason: string;
	emptyMean: number;
	learnedMean: number;
} {
	const paired: TaskPairedScores = {};
	for (const [task, s] of Object.entries(byTask)) {
		paired[task] = { parent: s.empty, candidate: s.learned };
	}
	const d = decideRevision({ byTask: paired, minRepsPerTask: 3 });
	return {
		decision: d.decision,
		reason: d.reason,
		emptyMean: d.parentMean,
		learnedMean: d.candidateMean,
	};
}
