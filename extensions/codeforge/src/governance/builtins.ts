/**
 * Default skills / rules / policies / guardrails for CodeForge Agent.
 *
 * Tone: neutral instructions that agree with the system prompt and the tool descriptions.
 * Anything the IDE enforces lives in code (oracle, gates), not here.
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
			description: 'Understand → edit one concern → build/test → fix loop',
			triggers: ['agent', 'implement', 'fix', 'build', 'criar', 'implementar'],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'Loop: understand the target → change one concern (`edit` for existing files, `write` for new files) → build/test → fix the reported errors → repeat.',
				'Confirm that the types, methods and routes you use exist (search/symbols) before calling them.',
				'After a failed build/test, fix the listed errors first; unrelated refactors can wait.',
				'The task is done when build/test is green — the IDE runs the check when you finish. If you cannot finish, reply with `blocked: <reason>`.',
				'Final reply: what changed and how to run it.',
			].join('\n'),
		},
		{
			id: 'skill.dotnet-razor',
			kind: 'skill',
			title: 'ASP.NET Razor / MVC / EF',
			description: 'Conventions for ASP.NET Core web UI and EF Core',
			triggers: ['razor', 'cshtml', 'blazor', 'aspnet', 'asp.net', 'mvc', 'ef core', 'entityframework', 'entity framework'],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'Keep the stack the repo already uses:',
				'- Razor Pages: Pages/*.cshtml with @page on the first line, PageModel in *.cshtml.cs.',
				'- MVC: Controllers + Views/ (Views have no @page).',
				'Models in Models/, services in Services/, DI registration in Program.cs.',
				'Blazor WebAssembly package: Microsoft.AspNetCore.Components.WebAssembly.',
				'EF Core: package versions match the project TFM; add one package at a time.',
				'Validation helpers: asp-validation-for / ValidationMessageFor.',
				'RZ3906 → @page belongs on line 1 of a Razor Page, and never in MVC Views.',
			].join('\n'),
		},
		{
			id: 'skill.harness-weak-models',
			kind: 'skill',
			title: 'Working style for local models',
			description: 'Small steps with frequent verification',
			triggers: ['weak', 'harness', 'local model', 'ollama'],
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content: [
				'1. One file and one concern per turn. Existing files: `edit` with an exact old_string. New files: `write`.',
				'2. Confirm API signatures with symbols/definition/search before using them.',
				'3. Read slices with startLine+limit. Content already in this chat does not need to be read again.',
				'4. After two or three edits, build or test.',
				'5. When the task comes from a card (docs/C*.md), its acceptance criteria are the plan.',
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
				'Use relative workspace paths. Destructive shell commands need user approval. Use the project roots listed in STABLE FACTS; confirm APIs with search/symbols before using them.',
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
				'Change existing files with `edit`; rewrite a whole file only when most of it changes. Keep scope to what the user asked and avoid duplicate types/files.',
		},
		{
			id: 'rule.build-loop',
			kind: 'rule',
			title: 'Build loop',
			description: 'Build/test after meaningful edits',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'After meaningful edits, run the project build or test (dotnet build/test, npm test, pytest). When it fails, fix those errors before adding features.',
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
			description: 'Run the oracle after N writes without a build',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxWritesWithoutBuild: 3,
			},
			content:
				'After N file writes without a successful build/test, the IDE runs the project build/test (oracle) and returns the result to the agent.',
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
				'After a failed build, work on the reported errors (targeted read/fix) until the build succeeds.',
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
			description: 'After a failed build, return the error list and focus the fix phase',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				blockExploreWhileBuildRed: true,
			},
			content:
				'When build/test exits ≠ 0, the error list is kept in STABLE FACTS. Weak profile: after 3 reads with a red build, broad exploration is refused until an edit or build.',
		},
		{
			id: 'guard.require-build-after-writes',
			kind: 'guardrail',
			gateId: 'require_build_after_writes',
			title: 'Oracle after writes',
			description: 'Run build/test automatically after N writes',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxWritesWithoutBuild: 3,
			},
			content:
				'After N successful writes without a build/test, the IDE runs the oracle and appends its result.',
		},
		{
			id: 'guard.require-plan-before-writes',
			kind: 'guardrail',
			gateId: 'require_plan_before_writes',
			title: 'Plan before writes',
			description: 'Off by default — cards and the orchestrator provide the plan',
			enabled: false,
			builtin: true,
			updatedAt: now(),
			content:
				'When enabled: before the first write, suggest wiki document id=task-plan with a checklist and Definition of Done.',
		},
		{
			id: 'guard.require-failing-test-before-impl',
			kind: 'guardrail',
			gateId: 'require_failing_test_before_impl',
			title: 'TDD: failing test before impl',
			description: 'Optional — off by default (advice only when on)',
			enabled: false,
			builtin: true,
			updatedAt: now(),
			params: {
				maxImplWritesAfterRed: 3,
			},
			content:
				'When enabled: suggest a failing test before production writes.',
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
				'Keep openErrors / last build failure in STABLE FACTS and re-inject after compact.',
		},
		{
			id: 'guard.block-mass-rewrite',
			kind: 'guardrail',
			gateId: 'block_mass_rewrite',
			title: 'Large-file rewrite gate',
			description: 'Weak profile: full rewrite of a large existing file is refused in favour of edit',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			params: {
				maxConsecutiveFileWrites: 8,
				largeFileLines: 60,
			},
			content:
				'Weak profile: `write` over an existing file with more than N lines is refused; the agent uses `edit` instead.',
		},
		{
			id: 'guard.one-stack-dotnet',
			kind: 'guardrail',
			gateId: 'one_stack_dotnet',
			title: 'One-stack .NET check',
			description: 'Warn on @page inside Views/',
			enabled: true,
			builtin: true,
			updatedAt: now(),
			content:
				'If a write targets Views/** and contains @page, the tool result carries a stack warning (the tool still runs).',
		},
		{
			id: 'guard.anti-explore-loop',
			kind: 'guardrail',
			gateId: 'anti_explore_loop',
			title: 'Anti explore-loop',
			description: 'Retired — toolsets per phase replace it',
			enabled: false,
			builtin: true,
			updatedAt: now(),
			content: 'Retired: phase toolsets decide which tools are available.',
		},
	];
}

export function builtinGovernanceState(): GovernanceState {
	return {
		version: 5,
		skills: builtinSkills(),
		rules: builtinRules(),
		policies: builtinPolicies(),
		guardrails: builtinGuardrails(),
	};
}
