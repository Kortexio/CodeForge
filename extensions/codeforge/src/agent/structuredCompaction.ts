/**
 * Structured LLM compaction template (opencode-inspired).
 * Pure helpers — the agent loop owns the LLM call.
 */

export const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the tags in your response.

## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
`;

export const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`;

export function buildCompactionPrompt(opts: {
	update: boolean;
	planHint?: string;
}): string {
	const shared = [
		'Summarize only what the user and the assistant said and did. Leave out repository conventions and environment setup the next agent receives separately.',
		SUMMARY_TEMPLATE,
		SUMMARY_RULES,
		'Do not continue the task or call tools.',
		'Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.',
		opts.planHint ? `Internal plan focus (model-only): ${opts.planHint}` : '',
	].filter(Boolean);
	if (!opts.update) {
		return [
			'You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.',
			...shared,
		].join('\n\n');
	}
	return [
		'Update the existing checkpoint in the conversation above into one consolidated summary.',
		'Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale.',
		'Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.',
		...shared,
	].join('\n\n');
}

export const COMPACTION_NUDGE =
	'The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.';

const REQUIRED_HEADINGS = [
	'## Objective',
	'## Work State',
	'## Next Move',
];

export function looksLikeStructuredSummary(text: string): boolean {
	const t = String(text || '');
	return REQUIRED_HEADINGS.every(h => t.includes(h));
}

export function formatCheckpointUserMessage(summary: string, readLedger?: string): string {
	const ledger = readLedger?.trim()
		? `\n\n### FILES ALREADY READ\n${readLedger.trim()}`
		: '';
	return `### Checkpoint (compacted context)\n${summary.trim()}${ledger}`;
}
