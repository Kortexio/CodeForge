/**
 * Harness messages for protocol events (truncation, budget, oracle) — not intent coaching.
 * Pure (no vscode) so they are unit-testable.
 */

/** The model's final text claims build/tests are green (PT + EN phrasing in matchers only). */
export function claimsBuildOrTestGreen(text: string): boolean {
	const t = String(text || '');
	const negated =
		/\bn[ãa]o\s+(compila|passa|est[áa]\s+verde)|\b(tests?|build)\s+(failed|failing)\b|\b[1-9]\d*\s+(errors?|erros?|failures?|falhas?|failed)\b/i.test(
			t
		);
	if (negated) return false;
	return (
		/\b(all\s+)?(passing|passed|green|verde|0\s+errors?|0\s+erros?|0\s+failures?|0\s+falhas?|build\s+succeeded|build\s+ok|tests?\s+pass)/i.test(t) ||
		/\ball\s+green\b|\btudo\s+verde\b/i.test(t) ||
		/\b(compila|compilou|compilando)\b/i.test(t) ||
		/\bsem\s+(erros?|falhas?)\b/i.test(t) ||
		/\btestes?\s+(passa|passam|passaram|ok|verdes?)\b/i.test(t) ||
		/\b(build|compila[çc][ãa]o)\s+(com\s+sucesso|bem[-\s]sucedid[ao]|ok)\b/i.test(t)
	);
}

/** Completion hit max_tokens before a tool call was complete (a technical event). */
export const LENGTH_CAP_NOTE = [
	'Your last reply hit the output token limit (stop reason: length).',
	'Do not apologize or repeat yourself. Break the remaining work into smaller pieces.',
	'Continue with one tool call; for a large file, write it in parts or change it with edit.',
].join('\n');

/**
 * Keep tool definitions on the wire (prefix-cache friendly) but forbid further calls.
 * Used when the step budget is exhausted (not for stuck-tool loops — see STUCK_WRAP_PROMPT).
 */
export const MAX_STEPS_PROMPT = [
	'CRITICAL — MAXIMUM STEPS REACHED',
	'',
	'The step budget for this turn is exhausted. Tools are disabled until the next user message. Respond with text only.',
	'',
	'STRICT REQUIREMENTS:',
	'1. Do NOT make any tool calls',
	'2. State clearly that maximum steps for this agent have been reached',
	'3. Summarize what was actually done (files written/edited, commands run) — do not invent applied patches',
	'4. List remaining work as concrete next steps (file + change), not as unapplied code blocks',
	'',
	'Any attempt to use tools is a critical violation. Respond with text ONLY.',
].join('\n');

/**
 * Tool loop stuck (cache-only / identical batches / explore streak). Distinct from step budget.
 */
export const STUCK_WRAP_PROMPT = [
	'CRITICAL — TOOLS STUCK WITHOUT PROGRESS',
	'',
	'Recent tool calls repeated without new results. Tools are disabled until the next user message. Respond with text only.',
	'',
	'STRICT REQUIREMENTS:',
	'1. Do NOT make any tool calls',
	'2. State that tools were stuck without new progress',
	'3. Summarize what is already known from tool results',
	'4. Give one concrete next step for the user (file path + change), without pasting a full unapplied patch',
	'',
	'Respond with text ONLY.',
].join('\n');

/**
 * Gateway rejected tool_call.arguments JSON (truncated mid-string, bad quotes, or XML crumbs).
 */
export const TRUNCATED_TOOL_JSON_NOTE = [
	'The gateway rejected your last tool call: arguments were not valid JSON (cut off mid-string, missing quote, or XML tags mixed in).',
	'Retry with ONE native tool call only:',
	'- Prefer edit with a short unique old_string (3–15 lines) and a short new_string (under ~40 lines).',
	'- Arguments must be JSON: {"path":"...","old_string":"...","new_string":"..."}.',
	'- Do not use XML like <parameter=...> or </new_string>.',
	'- If the change is large, split into several small edits.',
].join('\n');

export const TRUNCATED_TOOL_JSON_FINAL_NOTE = [
	'Still getting invalid tool JSON from the gateway.',
	'Read the target file again, then apply one tiny edit (one function or one listener block only).',
	'If you cannot patch safely, reply with a short summary of what is broken and the exact lines to change.',
].join('\n');

/** Empty reply before any work was done (sent at most twice). */
export const EMPTY_TURN_NOTE =
	'The reply was empty. Continue with the next tool call, or reply with a summary if the task is done.';

/** Soft reminder (no longer blocks the user-visible reply). */
export const STATUS_UPDATE_NOTE = [
	'Prefer calling update_status with objective, stoppedAt, and next before you wrap up.',
	'If you skip it, the harness still records a stop point for the next turn.',
].join('\n');

/** Finish refused: the oracle is red. `oracleText` is the formatted oracle result. */
export function oracleRejectNote(oracleText: string): string {
	return [
		oracleText,
		'',
		'The task is not done while build/test is red. Fix the errors above, or reply with `blocked: <reason>` if you cannot.',
	].join('\n');
}

/** Appended to the user-facing reply (not sent to the model). */
export function finalReplyNote(kind: 'still-red' | 'unverified', command?: string): string {
	return kind === 'still-red'
		? `\n\n---\nOracle: build/test is still red (${command ?? 'build/test'}).`
		: '\n\n---\nNote: no build/test was verified after the last changes.';
}

/** The model explicitly declares it cannot finish (`blocked: <reason>`). */
export function parseBlockedClaim(text: string): string | undefined {
	const m = /(?:^|\n)\s*(?:\*\*)?(?:blocked|bloqueado)(?:\*\*)?\s*:\s*(.+)/i.exec(String(text || ''));
	return m ? m[1].trim().slice(0, 400) : undefined;
}
