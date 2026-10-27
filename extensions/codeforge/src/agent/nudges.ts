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
	'Continue with ONE tool call only:',
	'- For a new large file: write a minimal compilable skeleton (<60 lines), then add pieces with edit.',
	'- For .NET projects: prefer the dotnet tool (new / sln_add / add_reference) over hand-writing .csproj/.sln.',
	'- Keep tool arguments short; never paste a whole large file in one write/edit.',
].join('\n');

/** Length cap while finishing in prose (no tool call in progress). */
export const LENGTH_CAP_SUMMARY_NOTE = [
	'Your last reply hit the output token limit (stop reason: length).',
	'Reply with a short final summary only (≤15 lines). Do not paste large code blocks or long tables.',
	'If work remains, call one small tool instead of writing a long explanation.',
].join('\n');

/**
 * Keep tool definitions on the wire (prefix-cache friendly) but forbid further calls.
 * Used when the step budget is exhausted (not for stuck-tool loops — see stuckWrapPrompt).
 */
export const MAX_STEPS_PROMPT = [
	'CRITICAL — MAXIMUM STEPS REACHED',
	'',
	'The step budget for this turn is exhausted. Tools are disabled until the next user message. Respond with text only.',
	'',
	'STRICT REQUIREMENTS:',
	'1. Do NOT make any tool calls',
	'2. State clearly that the step budget for this turn was reached',
	'3. Summarize what was actually done (files written/edited, commands run) — do not invent applied patches',
	'4. List remaining work as concrete next steps (file + change), not as unapplied code blocks',
	'5. Do not ask the user to type "continue" — the UI offers a Continue button when the budget ends',
	'',
	'Any attempt to use tools is a critical violation. Respond with text ONLY.',
].join('\n');

/**
 * Restart after an identical-call streak. The turn keeps going; only that repeat loop ends.
 * Further reads of other paths are still allowed — verification is not a mutation.
 */
export const IDENTICAL_STALL_RECOVERY = [
	'The repeated calls have stopped. Those results are already in this conversation.',
	'Do not repeat those exact calls.',
	'Keep verifying with a different file, search, or command if you still need to check something.',
	'Edit only when that check shows a change to make.',
].join('\n');

/** Tool result when an explore call repeats. The previous body is not sent again. */
export function repeatedExploreRefusal(note: string): string {
	return [
		note,
		'This result is already in the conversation. It was not sent again.',
		'Do not repeat this exact call.',
		'You can still read or search a different path, or run a command, if you need to verify more.',
	].join('\n');
}

export function stuckWrapPrompt(cause: string): string {
	return [
		'CRITICAL — TOOLS STUCK WITHOUT PROGRESS',
		'',
		`Stop reason: ${cause}`,
		'',
		'Recent tool calls repeated without new results. Tools are disabled until the next user message. Respond with text only.',
		'',
		'STRICT REQUIREMENTS:',
		'1. Do NOT make any tool calls',
		'2. State the stop reason above',
		'3. Summarize what is already known from tool results',
		'4. Tell the user the next turn must use edit, write, shell, or browser (not only re-read)',
		'',
		'Respond with text ONLY.',
	].join('\n');
}

/**
 * Two length truncations exhausted. Text-only wrap — do not mention repeating tools.
 */
export const LENGTH_EXHAUSTED_PROMPT = [
	'CRITICAL — OUTPUT LENGTH LIMIT EXHAUSTED',
	'',
	'Repeated replies hit the output token limit (stop reason: length). Tools are disabled until the next user message. Respond with text only.',
	'',
	'STRICT REQUIREMENTS:',
	'1. Do NOT make any tool calls',
	'2. State clearly that the output length limit was exhausted after repeated truncations',
	'3. Summarize in ≤10 lines what is already known — do not invent applied patches',
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
	'- For a new large file: write a minimal skeleton (<60 lines), then grow it with edit one method/block at a time.',
	'- For .NET solution/project setup: prefer the dotnet tool (new / sln_add / add_reference / add_package) instead of writing large .csproj/.sln bodies.',
	'- Arguments must be JSON: {"path":"...","old_string":"...","new_string":"..."}.',
	'- Do not use XML like <parameter=...> or </new_string>.',
].join('\n');

export const TRUNCATED_TOOL_JSON_FINAL_NOTE = [
	'Still getting invalid tool JSON from the gateway.',
	'Read the target file again, then apply one tiny edit (one function or one listener block only).',
	'If creating projects, switch to the dotnet tool for scaffolding instead of large write payloads.',
	'If you cannot patch safely, reply with a short summary of what is broken and the exact lines to change.',
].join('\n');

/**
 * Structural one-shot: production code changed after reading a spec (or without touching tests).
 * Built from path sets only — not intent sniffing on reply text.
 */
export function specSelfCheckNote(opts: {
	sourcePaths: string[];
	specPaths: string[];
	testPaths: string[];
}): string {
	const sources = opts.sourcePaths.slice(0, 12).join(', ') || '(none)';
	const specs = opts.specPaths.slice(0, 8).join(', ') || '(none)';
	const tests = opts.testPaths.slice(0, 8).join(', ') || '(none)';
	return [
		'SPEC EDGE-CASE CHECK (one-shot)',
		`Source files changed: ${sources}`,
		`Spec/docs read this turn: ${specs}`,
		`Test files touched: ${tests}`,
		'Before finishing: re-read the listed spec/docs and check each stated rule against the code.',
		'Reading the code is not proof. For every rule with a limit (inclusive/exclusive bounds, dates or times, caps, rounding), execute the code at the exact boundary value and compare the output with the spec.',
		'Prefer a one-off shell command for these checks. Do not create, edit or delete any file under a test directory (tests/, test/, *.Tests) for these checks. If you need a temporary file or project, put it outside the workspace (OS temp dir) and delete it before finishing.',
		'If the code cannot be executed with a one-off command (e.g. a compiled project), do not scaffold a new project or test file: the existing test suite is the executable check, and each boundary condition in the source (comparison operator, inclusive/exclusive, date vs date-time) must be re-checked against the spec wording.',
		'Date-only values (e.g. "2020-01-01") parse to midnight; a rule "valid up to and including that date" must still hold later on the same day.',
		'Do not invent requirements that are not written in those specs.',
		'If a boundary check fails, call edit on the source, then re-run the test suite.',
		'If every boundary check matches the written specs, reply with a short summary.',
	].join('\n');
}

/** Empty reply before any work was done (sent at most twice). */
export const EMPTY_TURN_NOTE =
	'The reply was empty. Continue with the next tool call, or reply with a summary if the task is done.';

/**
 * Protocol: exploration-only tools then prose finish is not done (sent at most twice).
 * Structural — based on tool counts, not user-phrase matchers.
 */
export const DIAG_ONLY_FINISH_NOTE = [
	'Implementation turn is not done after exploration-only tools (read/search/list/…).',
	'Call an effectful tool now (edit, write, shell, or browser click/type/navigate) to apply a change, or reply with `blocked: <reason>` if you cannot.',
	'A bug list or plan alone does not finish the task.',
].join('\n');

/**
 * One-shot: build/test green is not enough for runnable apps — launch and observe.
 * Structural (tool counts) — not reply-text sniffing.
 */
export function runtimeVerifyNote(opts?: { sourcePaths?: string[] }): string {
	const sources = (opts?.sourcePaths ?? []).slice(0, 12).join(', ') || '(changed sources)';
	return [
		'RUNTIME VERIFY (one-shot)',
		`Source files changed: ${sources}`,
		'Build/test green is not enough. Launch the app (or open it in the browser), then observe the result.',
		'Do one of:',
		'- Web / UI: browser_navigate (or click through the flow) then browser_snapshot or browser_screenshot; use the After-state as ground truth.',
		'- Desktop / local: shell with the project run/start script (or the existing launch command), then check process output or reopen and confirm the feature works.',
		'Do not treat `npm test` / `dotnet test` / oracle build as this check — those already ran.',
		'Do not create or edit files under test directories for this check. Prefer existing start/dev/run scripts.',
		'If the app opens but the feature still fails, call edit and fix, then re-verify.',
		'If you cannot launch (missing runtime, no display), reply `blocked: <reason>`.',
		'Only after a successful launch+observe, reply with a short summary.',
	].join('\n');
}

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

/** Empty / placeholder blocked reasons the model invents — not real blockers. */
const EMPTY_BLOCKED_REASONS = new Set([
	'none',
	'nothing',
	'n/a',
	'na',
	'-',
	'—',
	'.',
	'no',
	'ok',
	'null',
	'undefined',
]);

/** The model explicitly declares it cannot finish (`blocked: <reason>`). */
export function parseBlockedClaim(text: string): string | undefined {
	const m = /(?:^|\n)\s*(?:\*\*)?(?:blocked|bloqueado)(?:\*\*)?\s*:\s*(.+)/i.exec(String(text || ''));
	if (!m) return undefined;
	const reason = m[1].trim().slice(0, 400);
	const normalized = reason.replace(/[*_`]+/g, '').trim().toLowerCase();
	if (!normalized || EMPTY_BLOCKED_REASONS.has(normalized)) return undefined;
	return reason;
}

