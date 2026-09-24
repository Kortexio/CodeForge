/**
 * Persist and merge editable governance (skills / rules / policies / guardrails).
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { builtinGovernanceState } from './builtins';
import {
	GovernanceState,
	GovernanceItem,
	GovernanceKind,
	SkillItem,
	RuleItem,
	PolicyItem,
	GuardrailItem,
	GuardrailRuntimeConfig,
} from './types';

const STATE_KEY = 'codeforge.ai.governance.v1';
const BUILTIN_GOVERNANCE_VERSION = 5;

/** v5: replaced by resources/skills/dotnet-error-cookbook.md (hints attached per error code). */
const REMOVED_SKILL_IDS = new Set(['skill.dotnet-build-fix']);

/** Rules removed from the builtins — drop from saved state so they stop polluting prompts. */
const REMOVED_RULE_IDS = new Set([
	'rule.plan-before-code',
	'rule.one-file-turn',
	'rule.verify-apis',
	// v4: moved to resources/rules/one-stack.mdc (path-activated on Razor/MVC files only).
	'rule.one-stack',
]);

/** Guardrails whose default flipped to off in v4 (plan-first conflicts with card-driven work). */
const DISABLED_IN_V4 = new Set(['guard.require-plan-before-writes', 'guard.anti-explore-loop']);

function mergeById<T extends { id: string; builtin?: boolean }>(
	builtins: T[],
	saved: T[] | undefined
): T[] {
	const map = new Map<string, T>();
	for (const b of builtins) {
		map.set(b.id, { ...b });
	}
	for (const s of saved ?? []) {
		if (map.has(s.id)) {
			map.set(s.id, { ...map.get(s.id)!, ...s, builtin: true });
		} else {
			map.set(s.id, { ...s, builtin: s.builtin ?? false });
		}
	}
	const builtinIds = new Set(builtins.map(b => b.id));
	const customs = [...map.values()].filter(x => !builtinIds.has(x.id));
	return [...builtins.map(b => map.get(b.id)!), ...customs];
}

function applyBuiltinDefaultsV2(state: GovernanceState): GovernanceState {
	const builtins = builtinGovernanceState();
	const byId = <T extends { id: string }>(list: T[]) => new Map(list.map(x => [x.id, x]));

	const gBuilt = byId(builtins.guardrails);
	const pBuilt = byId(builtins.policies);

	state.rules = state.rules.filter(r => !REMOVED_RULE_IDS.has(r.id));

	for (const g of state.guardrails) {
		const b = gBuilt.get(g.id);
		if (!b) continue;
		if (
			g.id === 'guard.anti-explore-loop' ||
			g.id === 'guard.require-failing-test-before-impl'
		) {
			g.enabled = false;
		}
		if (g.id === 'guard.require-build-after-writes') {
			g.params = { ...g.params, maxWritesWithoutBuild: 3 };
		}
		if (g.id === 'guard.block-mass-rewrite') {
			g.params = { ...g.params, maxConsecutiveFileWrites: 8 };
		}
		g.description = b.description;
		g.content = b.content;
		g.title = b.title;
	}

	for (const p of state.policies) {
		const b = pBuilt.get(p.id);
		if (!b) continue;
		if (p.id === 'policy.write-budget') {
			p.params = { ...p.params, maxWritesWithoutBuild: 3 };
			p.content = b.content;
		}
		if (p.id === 'policy.failed-build-discipline') {
			p.content = b.content;
		}
	}

	state.version = BUILTIN_GOVERNANCE_VERSION;
	return state;
}

/** v4: refresh builtin texts (saved copies override builtins in mergeById) and new defaults. */
function applyBuiltinDefaultsV4(state: GovernanceState): GovernanceState {
	const builtins = builtinGovernanceState();
	const refresh = <T extends { id: string; builtin?: boolean }>(list: T[], fresh: T[], keys: (keyof T)[]) => {
		const byId = new Map(fresh.map(x => [x.id, x]));
		for (const item of list) {
			const b = byId.get(item.id);
			if (!b) continue;
			for (const k of keys) {
				item[k] = b[k];
			}
		}
	};
	refresh(state.skills, builtins.skills, ['title', 'description', 'content', 'triggers']);
	refresh(state.rules, builtins.rules, ['title', 'description', 'content']);
	refresh(state.policies, builtins.policies, ['title', 'description', 'content']);
	refresh(state.guardrails, builtins.guardrails, ['title', 'description', 'content', 'params']);
	state.rules = state.rules.filter(r => !REMOVED_RULE_IDS.has(r.id));
	for (const g of state.guardrails) {
		if (DISABLED_IN_V4.has(g.id)) g.enabled = false;
	}
	state.version = BUILTIN_GOVERNANCE_VERSION;
	return state;
}

/** Instruction blocks are never cut: whole text when it fits, otherwise the one-line description. */
export function fitInstruction(
	title: string,
	content: string,
	description: string | undefined,
	remaining: number
): { text: string; full: boolean } | undefined {
	const full = `### ${title}\n${content.trim()}`;
	if (full.length <= remaining) return { text: full, full: true };
	const short = description?.trim() ? `### ${title}\n${description.trim()}` : '';
	if (short && short.length <= remaining) return { text: short, full: false };
	return undefined;
}

export class GovernanceStore {
	private readonly _onDidChange = new vscode.EventEmitter<GovernanceState>();
	readonly onDidChange = this._onDidChange.event;
	private migrating = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	getState(): GovernanceState {
		const builtins = builtinGovernanceState();
		const raw = this.context.globalState.get<Partial<GovernanceState>>(STATE_KEY);
		let state: GovernanceState = {
			version: typeof raw?.version === 'number' ? raw.version : 1,
			skills: mergeById(builtins.skills, raw?.skills).filter(s => !REMOVED_SKILL_IDS.has(s.id)),
			rules: mergeById(builtins.rules, raw?.rules).filter(r => !REMOVED_RULE_IDS.has(r.id)),
			policies: mergeById(builtins.policies, raw?.policies),
			guardrails: mergeById(builtins.guardrails, raw?.guardrails),
		};

		if ((state.version ?? 1) < BUILTIN_GOVERNANCE_VERSION) {
			if ((state.version ?? 1) < 3) {
				state = applyBuiltinDefaultsV2(state);
			}
			state = applyBuiltinDefaultsV4(state);
			if (!this.migrating) {
				this.migrating = true;
				void this.save(state).finally(() => {
					this.migrating = false;
				});
			}
		}

		return state;
	}

	async save(state: GovernanceState): Promise<void> {
		await this.context.globalState.update(STATE_KEY, {
			...state,
			version: BUILTIN_GOVERNANCE_VERSION,
		});
		this._onDidChange.fire(this.getState());
	}

	async upsert(item: GovernanceItem): Promise<void> {
		const state = this.getState();
		const list = listFor(state, item.kind) as GovernanceItem[];
		const idx = list.findIndex(x => x.id === item.id);
		const next = { ...item, updatedAt: new Date().toISOString() } as GovernanceItem;
		if (idx >= 0) {
			list[idx] = next;
		} else {
			list.push(next);
		}
		setList(state, item.kind, list);
		await this.save(state);
	}

	async setEnabled(kind: GovernanceKind, id: string, enabled: boolean): Promise<void> {
		const state = this.getState();
		const item = listFor(state, kind).find(x => x.id === id);
		if (!item) return;
		item.enabled = enabled;
		item.updatedAt = new Date().toISOString();
		await this.save(state);
	}

	async remove(kind: GovernanceKind, id: string): Promise<void> {
		const state = this.getState();
		const list = listFor(state, kind);
		const item = list.find(x => x.id === id);
		if (!item || item.builtin) {
			throw new Error('Built-in items cannot be deleted (disable instead)');
		}
		setList(
			state,
			kind,
			list.filter(x => x.id !== id)
		);
		await this.save(state);
	}

	async resetBuiltin(kind: GovernanceKind, id: string): Promise<void> {
		const builtins = builtinGovernanceState();
		const fresh = listFor(builtins, kind).find(x => x.id === id);
		if (!fresh) return;
		await this.upsert({ ...fresh });
	}

	createDraft(kind: GovernanceKind): GovernanceItem {
		const id = `custom.${kind}.${randomUUID().slice(0, 8)}`;
		const base = {
			id,
			title: `New ${kind}`,
			description: '',
			content: '',
			enabled: true,
			builtin: false,
			updatedAt: new Date().toISOString(),
		};
		if (kind === 'skill') {
			return { ...base, kind: 'skill', triggers: [] } satisfies SkillItem;
		}
		if (kind === 'rule') {
			return { ...base, kind: 'rule' } satisfies RuleItem;
		}
		if (kind === 'policy') {
			return { ...base, kind: 'policy', params: {} } satisfies PolicyItem;
		}
		return {
			...base,
			kind: 'guardrail',
			gateId: id,
			params: {},
		} satisfies GuardrailItem;
	}

	buildPromptSection(
		task: string,
		opts?: { forceSkillIds?: string[]; charBudget?: number }
	): string {
		return buildGovernancePrompt(this.getState(), task, opts);
	}

	runtimeConfig(overrides?: Partial<GuardrailRuntimeConfig>): GuardrailRuntimeConfig {
		const state = this.getState();
		const on = (gateId: string) =>
			state.guardrails.some(g => g.enabled && g.gateId === gateId);
		const guard = (gateId: string) =>
			state.guardrails.find(g => g.gateId === gateId && g.enabled);
		const policyWrite = state.policies.find(p => p.id === 'policy.write-budget' && p.enabled);
		const policyFail = state.policies.find(
			p => p.id === 'policy.failed-build-discipline' && p.enabled
		);

		const maxWrites =
			numParam(guard('require_build_after_writes')?.params, 'maxWritesWithoutBuild') ??
			numParam(policyWrite?.params, 'maxWritesWithoutBuild') ??
			3;
		const maxConsecutive =
			numParam(guard('block_mass_rewrite')?.params, 'maxConsecutiveFileWrites') ?? 8;
		const blockExplore =
			boolParam(guard('build_fix_gate')?.params, 'blockExploreWhileBuildRed') ??
			boolParam(policyFail?.params, 'blockExploreWhileBuildRed') ??
			true;
		const maxImplWritesAfterRed =
			numParam(guard('require_failing_test_before_impl')?.params, 'maxImplWritesAfterRed') ?? 3;

		const weak = overrides?.weakProfile === true;
		const base: GuardrailRuntimeConfig = {
			buildFixGate: on('build_fix_gate'),
			requireBuildAfterWrites: on('require_build_after_writes'),
			maxWritesWithoutBuild: weak ? Math.min(maxWrites, 2) : maxWrites,
			preserveBuildErrorsOnCompact: on('preserve_build_errors_on_compact'),
			blockMassRewrite: on('block_mass_rewrite'),
			maxConsecutiveFileWrites: maxConsecutive,
			oneStackDotnet: on('one_stack_dotnet'),
			antiExploreLoop: on('anti_explore_loop'),
			blockExploreWhileBuildRed: blockExplore,
			requirePlanBeforeWrites: on('require_plan_before_writes') && weak,
			requireFailingTestBeforeImpl: on('require_failing_test_before_impl') && weak,
			maxImplWritesAfterRed,
			weakProfile: weak,
		};
		// Ignore requireFailingTestBeforeImpl overrides that would force TDD on when the gate is off.
		const { requireFailingTestBeforeImpl: _ignoredTdd, ...rest } = overrides ?? {};
		void _ignoredTdd;
		return {
			...base,
			...rest,
			requireFailingTestBeforeImpl: base.requireFailingTestBeforeImpl,
			weakProfile: weak || overrides?.weakProfile === true,
		};
	}
}

/**
 * Rules + relevant skills for the system prompt. Items are selected (never truncated):
 * each block goes in whole, or as its description, or not at all.
 * Guardrails are not listed — they act at tool time and speak through tool results.
 */
export function buildGovernancePrompt(
	state: GovernanceState,
	task: string,
	opts?: { forceSkillIds?: string[]; charBudget?: number }
): string {
	const q = task.toLowerCase();
	const budget = opts?.charBudget ?? 6000;
	const rules = state.rules.filter(r => r.enabled);
	const forced = new Set(opts?.forceSkillIds ?? []);
	const enabledSkills = state.skills.filter(s => s.enabled);
	const matched = enabledSkills.filter(
		s =>
			!forced.has(s.id) &&
			s.id !== 'skill.agent-workflow' &&
			(s.triggers.some(t => q.includes(t.toLowerCase())) ||
				s.title.toLowerCase().split(/\s+/).some(w => w.length > 3 && q.includes(w)))
	);
	const ordered = [
		...enabledSkills.filter(s => s.id === 'skill.agent-workflow'),
		...enabledSkills.filter(s => forced.has(s.id) && s.id !== 'skill.agent-workflow'),
		...matched.slice(0, 3),
	];

	let remaining = budget;
	const ruleLines: string[] = [];
	for (const r of rules) {
		const line = `- ${r.title}: ${r.content.trim()}`;
		const alt = r.description ? `- ${r.title}: ${r.description.trim()}` : '';
		const pick = line.length <= remaining ? line : alt && alt.length <= remaining ? alt : '';
		if (!pick) continue;
		ruleLines.push(pick);
		remaining -= pick.length + 1;
	}
	const skillBlocks: string[] = [];
	for (const s of ordered) {
		const fit = fitInstruction(s.title, s.content, s.description, remaining);
		if (!fit) continue;
		skillBlocks.push(fit.text);
		remaining -= fit.text.length + 1;
	}
	const parts: string[] = [];
	if (ruleLines.length) parts.push('## Active Rules', ...ruleLines);
	if (skillBlocks.length) parts.push('## Relevant Skills', ...skillBlocks);
	return parts.join('\n');
}

function listFor(state: GovernanceState, kind: GovernanceKind): GovernanceItem[] {
	switch (kind) {
		case 'skill':
			return state.skills;
		case 'rule':
			return state.rules;
		case 'policy':
			return state.policies;
		case 'guardrail':
			return state.guardrails;
	}
}

function setList(state: GovernanceState, kind: GovernanceKind, items: GovernanceItem[]): void {
	switch (kind) {
		case 'skill':
			state.skills = items as SkillItem[];
			break;
		case 'rule':
			state.rules = items as RuleItem[];
			break;
		case 'policy':
			state.policies = items as PolicyItem[];
			break;
		case 'guardrail':
			state.guardrails = items as GuardrailItem[];
			break;
	}
}

function numParam(
	params: Record<string, number | boolean | string> | undefined,
	key: string
): number | undefined {
	const v = params?.[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolParam(
	params: Record<string, number | boolean | string> | undefined,
	key: string
): boolean | undefined {
	const v = params?.[key];
	return typeof v === 'boolean' ? v : undefined;
}

let shared: GovernanceStore | undefined;

export function initGovernanceStore(context: vscode.ExtensionContext): GovernanceStore {
	shared = new GovernanceStore(context);
	return shared;
}

export function getGovernanceStore(): GovernanceStore {
	if (!shared) {
		throw new Error('GovernanceStore not initialized');
	}
	return shared;
}
