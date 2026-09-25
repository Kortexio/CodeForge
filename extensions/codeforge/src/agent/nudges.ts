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

/** Finish refused once: this run has not written .CodeForge/memory/status.json. */
export const STATUS_UPDATE_NOTE = [
	'The final reply waits for update_status.',
	'Call update_status with objective, stoppedAt, and next (blockers and files when you have them).',
	'That file is what the next turn reads. Do not scan the repo to reconstruct where the work stopped.',
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
