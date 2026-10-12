/**
 * Harness messages injected into the chat and the checks that decide when to send them.
 * Pure (no vscode) so they are unit-testable.
 */

/** The model's final text claims build/tests are green (PT + EN phrasing). */
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
	'Your last reply hit the output token limit before a tool call was complete.',
	'Continue with one tool call; for a large file, write it in parts or change it with edit.',
].join('\n');

/** Empty reply before any work was done (sent at most twice). */
export const EMPTY_TURN_NOTE =
	'The reply was empty. Continue with the next tool call, or reply with a summary if the task is done.';

/**
 * Model narrated the next step ("I'll list…", "Vou verificar…") without tool_calls.
 * Without a nudge the harness treats that prose as the final reply and stops mid-analysis.
 */
export function looksLikeIncompleteIntent(text: string): boolean {
	const t = String(text || '').trim();
	if (!t) return false;
	// Long replies are usually real answers; keep the gate on short/mid preambles.
	if (t.length > 1200) return false;
	if (parseBlockedClaim(t)) return false;
	if (
		/\b(vou|irei|vamos|deix[ae]-me|deixa eu)\b/i.test(t) ||
		/\b(I('ll| will)|Let me|I'm going to|I am going to)\b/i.test(t) ||
		/\b(next\s+I('ll| will)|em seguida|agora vou|primeiro vou)\b/i.test(t)
	) {
		return true;
	}
	// Trailing ellipsis on a short message often means "more coming".
	if (t.length < 400 && /\.{2,}\s*$/.test(t)) return true;
	return false;
}

/** Intent-only reply: force the model to actually call tools (at most twice). */
export const INTENT_CONTINUE_NOTE = [
	'You described the next step but did not call a tool.',
	'Continue now with the tool call(s) needed — do not only narrate.',
].join('\n');

/** Tools ran but the final prose has no real findings (common after helper writes). */
export const THIN_FINAL_NOTE = [
	'Tool results are available but this reply has no findings yet.',
	'Write the analysis or answer from those results now — do not stop after a helper script or a one-liner.',
].join('\n');

/** Short final after tools — likely not a complete answer. */
export function looksLikeThinFinal(text: string, hadToolActions: boolean): boolean {
	if (!hadToolActions) return false;
	const t = String(text || '').trim();
	if (!t) return true;
	if (parseBlockedClaim(t)) return false;
	if (t.length < 200) return true;
	return false;
}

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
