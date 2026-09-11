/**
 * Default skills / rules / policies / guardrails for CodeForge Agent.
 */

import {
	GovernanceState,
	SkillItem,
	RuleItem,
	PolicyItem,
	GuardrailItem,
} from './types';

function now(): string {
	return new Date().toISOString();
}

export function builtinSkills(): SkillItem[] {
	return [
		{
			id: 'skill.agent-workflow',
			kind: 'skill',
			title: 'Agent workflow',
			description: 'Explore → small edit → build → fix loop',
			triggers: ['agent', 'implement', 'fix', 'build', 'criar', 'implementar'],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'Work in a tight loop: explore minimally → edit one concern → run build/diagnostics → fix reported errors → repeat.',
				'Prefer retrieve/symbols over full-tree list. Do not rewrite the whole project.',
				'Never invent helpers, routes, or PagePath-like APIs — use framework APIs that already exist in the repo.',
				'After a failed build, ONLY fix the listed errors. Do not start unrelated refactors.',
				'When done: stop tools and summarize what changed + how to run.',
			].join('\n'),
		},
		{
			id: 'skill.dotnet-razor',
			kind: 'skill',
			title: '.NET / Razor',
			description: 'Conventions for ASP.NET Core Razor Pages / MVC',
			triggers: ['dotnet', 'csharp', 'razor', 'blazor', 'aspnet', 'funcionario', 'ef core'],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'Pick ONE stack and stick to it for the whole task:',
				'- Razor Pages: Pages/*.cshtml with @page first, PageModel in *.cshtml.cs',
				'- MVC: Controllers + Views/ (no @page in Views)',
				'Never mix @page into Views/ nor MVC Controllers into a Pages-only app mid-task.',
				'Models in Models/, services in Services/, DI in Program.cs.',
				'EF: match package versions to the TFM; add one package at a time; use Microsoft.EntityFrameworkCore.* (not obsolete Blazor packages).',
				'Validation: ValidationMessageFor / asp-validation-for — not ValidationFor.',
				'After scaffolding or edits: `dotnet build` on the .csproj (cwd = project folder). Fix CS/RZ errors before more features.',
				'Tool calls: keep write payloads small and complete — truncated JSON is rejected by the gateway.',
			].join('\n'),
		},
		{
			id: 'skill.dotnet-build-fix',
			kind: 'skill',
			title: '.NET build-fix',
			description: 'How to clear CS/RZ errors',
			triggers: ['build', 'error CS', 'RZ', 'MSB', 'failed'],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'When build fails: read the error list top-down.',
				'CS0101 duplicate type → delete or merge the duplicate file; do not create a third copy.',
				'RZ3906 @page must precede → move @page to line 1 or remove @page from MVC Views.',
				'CS1012 character literal → fix quotes (use strings, not multi-char \'…\').',
				'CS0246 type not found → usually a cascade from duplicate/broken types; fix the root definition first.',
				'One file patch per error cluster, then rebuild. Do not rewrite Models/Services/Views all at once.',
			].join('\n'),
		},
		{
			id: 'skill.harness-weak-models',
			kind: 'skill',
			title: 'Harness for weak (~27B) models',
			description: 'Tight loops, plan-first, TDD, verify APIs — for small local models',
			triggers: [
				'implement',
				'fix',
				'feature',
				'criar',
				'implementar',
				'bug',
				'refactor',
				'weak',
				'harness',
			],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'You are running under the weak-model harness. Shrink work until it fits a short context.',
				'1. BEFORE any production write: wiki_write id=task-plan with a numbered checklist + Definition of Done (build/test/endpoint criteria).',
				'2. One file / one concern per edit turn. Prefer surgical patches over rewrites.',
				'3. TDD-first when adding behavior: write a failing test, run it (red), then implement until green.',
				'4. Never invent API signatures — confirm with symbols/definition/search (or package docs) first.',
				'5. Prefer retrieve with small k over dumping whole files. Act from CONTEXT PACKET.',
				'6. After EACH production write: run build (or test). Do not batch many writes before validating.',
				'7. Prefer scaffolding (dotnet new, generators) over hand-rolled project structure.',
				'8. Record durable paths/versions/decisions with wiki_fact — do not re-derive from memory.',
				'9. When the DoD is met: stop tools and summarize briefly.',
			].join('\n'),
		},
	];
}

export function builtinRules(): RuleItem[] {
	return [
		{
			id: 'rule.safety',
			kind: 'rule',
			title: 'Safety',
			description: 'Default safety constraints',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Prefer relative workspace paths. Do not run destructive shell without approval. Prefer small reviewable diffs. Do not invent APIs or project roots.',
		},
		{
			id: 'rule.one-stack',
			kind: 'rule',
			title: 'One stack',
			description: 'No hybrid Razor Pages + MVC mid-task',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Do not mix Razor Pages (@page) and MVC Views/Controllers in the same change set. Detect the existing stack from the repo and stay consistent.',
		},
		{
			id: 'rule.small-diffs',
			kind: 'rule',
			title: 'Small diffs',
			description: 'Prefer surgical edits',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Prefer editing existing files over rewriting them. Avoid duplicate types/files. Cap scope to what the user asked.',
		},
		{
			id: 'rule.build-loop',
			kind: 'rule',
			title: 'Build loop',
			description: 'Build after edits',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'After meaningful writes, run dotnet build (or the project build command). If it fails, fix errors before adding features.',
		},
		{
			id: 'rule.plan-before-code',
			kind: 'rule',
			title: 'Plan before code',
			description: 'Checklist + DoD before mutating',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'For non-trivial tasks, write a short plan (wiki task-plan) with checklist and verifiable Definition of Done before the first production write.',
		},
		{
			id: 'rule.one-file-turn',
			kind: 'rule',
			title: 'One file per turn',
			description: 'Limit files touched per edit round',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Prefer at most 1–2 files per write round. Validate with build/test before spreading changes.',
		},
		{
			id: 'rule.verify-apis',
			kind: 'rule',
			title: 'Verify APIs',
			description: 'Do not invent signatures',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Never guess framework/library method signatures. Use symbols, definition, search, or package metadata first.',
		},
	];
}

export function builtinPolicies(): PolicyItem[] {
	return [
		{
			id: 'policy.approval-defaults',
			kind: 'policy',
			title: 'Approval defaults',
			description: 'How mutating tools are approved',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				autoApproveReadonly: true,
				respectAutoMode: true,
			},
			content:
				'Readonly tools never need approval. Mutating tools follow ApprovalPolicy / Auto mode. Auto mode may allow write+shell for the session.',
		},
		{
			id: 'policy.write-budget',
			kind: 'policy',
			title: 'Write budget',
			description: 'Limit writes without a successful build',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxWritesWithoutBuild: 1,
			},
			content:
				'If more than N file writes occur without a successful build/test shell, force a build before more writes (when the matching guardrail is on).',
		},
		{
			id: 'policy.failed-build-discipline',
			kind: 'policy',
			title: 'Failed-build discipline',
			description: 'While build is red, prioritize fixes',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				blockExploreWhileBuildRed: true,
			},
			content:
				'After a failed build, the agent should only patch files related to reported errors until build succeeds (enforced by build_fix_gate).',
		},
	];
}

export function builtinGuardrails(): GuardrailItem[] {
	return [
		{
			id: 'guard.build-fix-gate',
			kind: 'guardrail',
			gateId: 'build_fix_gate',
			title: 'Build-fix gate',
			description: 'After failed build, force fix phase',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				blockExploreWhileBuildRed: true,
			},
			content:
				'Hard: when shell runs a build/test and exit≠0, enter build-fix mode — nudge/block exploration until build succeeds or gate is disabled.',
		},
		{
			id: 'guard.require-build-after-writes',
			kind: 'guardrail',
			gateId: 'require_build_after_writes',
			title: 'Require build after writes',
			description: 'Block further writes until build runs',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxWritesWithoutBuild: 1,
			},
			content:
				'Hard: after N successful writes without a build/test shell, block more writes and require `dotnet build` (or equivalent).',
		},
		{
			id: 'guard.require-plan-before-writes',
			kind: 'guardrail',
			gateId: 'require_plan_before_writes',
			title: 'Require plan before writes',
			description: 'Block first production write until wiki task-plan exists',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Hard: before the first write/delete/rename, require wiki document id=task-plan (or fact plan.ready=true) with checklist + Definition of Done.',
		},
		{
			id: 'guard.require-failing-test-before-impl',
			kind: 'guardrail',
			gateId: 'require_failing_test_before_impl',
			title: 'TDD: failing test before impl',
			description: 'Under weak harness, require a red test before production writes',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxImplWritesAfterRed: 3,
			},
			content:
				'Hard (when weak profile is active): block production writes until a test command has failed once; test files are always allowed.',
		},
		{
			id: 'guard.preserve-build-errors',
			kind: 'guardrail',
			gateId: 'preserve_build_errors_on_compact',
			title: 'Preserve build errors on compact',
			description: 'Keep compiler errors across compact',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Hard: openErrors / last build failure stay in STABLE FACTS and are re-injected after compact.',
		},
		{
			id: 'guard.block-mass-rewrite',
			kind: 'guardrail',
			gateId: 'block_mass_rewrite',
			title: 'Block mass rewrite',
			description: 'Limit consecutive writes to different files',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxConsecutiveFileWrites: 5,
			},
			content:
				'Hard: stop chains of writes to many different files without an intervening build.',
		},
		{
			id: 'guard.one-stack-dotnet',
			kind: 'guardrail',
			gateId: 'one_stack_dotnet',
			title: 'One-stack .NET check',
			description: 'Warn/block @page inside Views/',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Hard: if write targets Views/** and content contains @page, reject or annotate as stack violation.',
		},
		{
			id: 'guard.anti-explore-loop',
			kind: 'guardrail',
			gateId: 'anti_explore_loop',
			title: 'Anti explore-loop',
			description: 'Steer to implement after long explore streaks',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'Soft/hard hybrid: after enough list/read/retrieve without writes, inject IMPLEMENTATION PHASE (existing behavior, toggleable).',
		},
	];
}

export function builtinGovernanceState(): GovernanceState {
	return {
		version: 1,
		skills: builtinSkills(),
		rules: builtinRules(),
		policies: builtinPolicies(),
		guardrails: builtinGuardrails(),
	};
}
