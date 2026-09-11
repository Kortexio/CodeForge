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

export class GovernanceStore {
	private readonly _onDidChange = new vscode.EventEmitter<GovernanceState>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	getState(): GovernanceState {
		const builtins = builtinGovernanceState();
		const raw = this.context.globalState.get<Partial<GovernanceState>>(STATE_KEY);
		return {
			version: 1,
			skills: mergeById(builtins.skills, raw?.skills),
			rules: mergeById(builtins.rules, raw?.rules),
			policies: mergeById(builtins.policies, raw?.policies),
			guardrails: mergeById(builtins.guardrails, raw?.guardrails),
		};
	}

	async save(state: GovernanceState): Promise<void> {
		await this.context.globalState.update(STATE_KEY, state);
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

	buildPromptSection(task: string, opts?: { forceSkillIds?: string[] }): string {
		const state = this.getState();
		const q = task.toLowerCase();
		const rules = state.rules.filter(r => r.enabled).slice(0, 12);
		const skills = state.skills
			.filter(s => s.enabled)
			.filter(
				s =>
					opts?.forceSkillIds?.includes(s.id) ||
					s.triggers.some(t => q.includes(t.toLowerCase())) ||
					s.title.toLowerCase().split(/\s+/).some(w => w.length > 3 && q.includes(w))
			)
			.slice(0, 6);
		const workflow = state.skills.find(s => s.id === 'skill.agent-workflow' && s.enabled);
		if (workflow && !skills.some(s => s.id === workflow.id)) {
			skills.unshift(workflow);
		}
		const weakSkill = state.skills.find(s => s.id === 'skill.harness-weak-models' && s.enabled);
		if (
			weakSkill &&
			opts?.forceSkillIds?.includes('skill.harness-weak-models') &&
			!skills.some(s => s.id === weakSkill.id)
		) {
			skills.unshift(weakSkill);
		}
		const parts: string[] = [];
		if (rules.length) {
			parts.push(
				'## Active Rules',
				...rules.map(r => `- ${r.title}: ${r.content.slice(0, 500)}`)
			);
		}
		if (skills.length) {
			parts.push(
				'## Relevant Skills',
				...skills.map(s => `### ${s.title}\n${s.content.slice(0, 2500)}`)
			);
		}
		const policies = state.policies.filter(p => p.enabled).slice(0, 6);
		if (policies.length) {
			parts.push(
				'## Active Policies',
				...policies.map(p => `- ${p.title}: ${p.content.slice(0, 400)}`)
			);
		}
		const gates = state.guardrails.filter(g => g.enabled);
		if (gates.length) {
			parts.push(
				'## Active Guardrails (enforced by IDE)',
				...gates.map(g => `- ${g.title}: ${g.description || g.content.slice(0, 200)}`)
			);
		}
		return parts.join('\n');
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
			1;
		const maxConsecutive =
			numParam(guard('block_mass_rewrite')?.params, 'maxConsecutiveFileWrites') ?? 5;
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
			maxWritesWithoutBuild: weak ? Math.min(maxWrites, 1) : maxWrites,
			preserveBuildErrorsOnCompact: on('preserve_build_errors_on_compact'),
			blockMassRewrite: on('block_mass_rewrite'),
			maxConsecutiveFileWrites: maxConsecutive,
			oneStackDotnet: on('one_stack_dotnet'),
			antiExploreLoop: on('anti_explore_loop'),
			blockExploreWhileBuildRed: blockExplore,
			requirePlanBeforeWrites: on('require_plan_before_writes') && weak,
			requireFailingTestBeforeImpl:
				(on('require_failing_test_before_impl') && weak) ||
				overrides?.requireFailingTestBeforeImpl === true,
			maxImplWritesAfterRed,
			weakProfile: weak,
		};
		return { ...base, ...overrides, weakProfile: weak || overrides?.weakProfile === true };
	}
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
