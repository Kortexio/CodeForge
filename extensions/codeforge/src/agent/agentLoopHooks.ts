/**
 * Plano B seams for the CodeForge loop. `prepareAgentRound` runs before each model
 * request (steering already queued, then the same history sanitize as before).
 * `finishAgentTurn` is the finish gate's continue/end answer. Abort stays outside.
 */

export function prepareAgentRound<T>(input: {
	messages: T[];
	keepReasoning: boolean;
	drainSteering?: () => string[];
	sanitize: (messages: T[], keepReasoning: boolean) => T[];
}): { messages: T[]; outbound: T[] } {
	const notes = input.drainSteering?.() ?? [];
	for (const text of notes) {
		if (!text.trim()) continue;
		input.messages.push({ role: 'user', content: text } as T);
	}
	return { messages: input.messages, outbound: input.sanitize(input.messages, input.keepReasoning) };
}

/** `continue` means the finish gate refused; `end` means the prose reply may close the turn. */
export function finishAgentTurn(input: { refuseDiag: boolean }): 'continue' | 'end' {
	return input.refuseDiag ? 'continue' : 'end';
}

/** Tools that may run together. One mutating or approval-gated call makes the whole batch sequential. */
export const PARALLEL_READ_TOOLS = new Set(['read', 'search', 'list']);

export function batchRunsInParallel(names: string[], needsApproval: (name: string) => boolean): boolean {
	if (!names.length) return false;
	return names.every(name => PARALLEL_READ_TOOLS.has(name) && !needsApproval(name));
}

/** Final actions. A batch of only these skips the next model round. */
export const TERMINAL_TOOLS = new Set(['update_status']);

export function batchTerminates(names: string[]): boolean {
	return names.length > 0 && names.every(name => TERMINAL_TOOLS.has(name));
}
