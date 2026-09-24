/**
 * Editable agent governance: skills, rules, policies, hard guardrails.
 */

export type GovernanceKind = 'skill' | 'rule' | 'policy' | 'guardrail';

export interface GovernanceItemBase {
	id: string;
	kind: GovernanceKind;
	title: string;
	description?: string;
	/** Soft prompt text (skills/rules) or policy notes. */
	content: string;
	enabled: boolean;
	/** Built-in items can be toggled/edited but not deleted. */
	builtin: boolean;
	updatedAt?: string;
}

export interface SkillItem extends GovernanceItemBase {
	kind: 'skill';
	/** Substrings that activate this skill for a task. */
	triggers: string[];
}

export interface RuleItem extends GovernanceItemBase {
	kind: 'rule';
}

export interface PolicyItem extends GovernanceItemBase {
	kind: 'policy';
	/** Optional numeric/bool knobs shown in Settings. */
	params?: Record<string, number | boolean | string>;
}

export interface GuardrailItem extends GovernanceItemBase {
	kind: 'guardrail';
	/** Hard gate id used by GuardrailEngine. */
	gateId: string;
	params?: Record<string, number | boolean | string>;
}

export type GovernanceItem = SkillItem | RuleItem | PolicyItem | GuardrailItem;

export interface GovernanceState {
	/** Bump when built-in defaults must be re-applied for existing installs. */
	version: number;
	skills: SkillItem[];
	rules: RuleItem[];
	policies: PolicyItem[];
	guardrails: GuardrailItem[];
}

export interface GuardrailRuntimeConfig {
	buildFixGate: boolean;
	requireBuildAfterWrites: boolean;
	maxWritesWithoutBuild: number;
	preserveBuildErrorsOnCompact: boolean;
	blockMassRewrite: boolean;
	maxConsecutiveFileWrites: number;
	oneStackDotnet: boolean;
	antiExploreLoop: boolean;
	/** Soft: still nudge; hard block explore tools while build is red. */
	blockExploreWhileBuildRed: boolean;
	/** Require wiki task-plan (or plan.ready fact) before first mutating write. */
	requirePlanBeforeWrites: boolean;
	/** TDD: require a failing test before production writes (usually weak profile). */
	requireFailingTestBeforeImpl: boolean;
	maxImplWritesAfterRed: number;
	/** Runtime: weak-model harness active for this run. */
	weakProfile: boolean;
}
