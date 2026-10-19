/**
 * Cursor-style browser observe helpers: action success ≠ expected outcome.
 * Compare page state before/after; the model must see the post-action world.
 */

export type PageState = {
	url: string;
	title: string;
	text: string;
};

/** Stable fingerprint for "did the UI change?" (not cryptographic). */
export function pageStateFingerprint(state: PageState): string {
	const body = state.text.replace(/\s+/g, ' ').trim().slice(0, 2500);
	return `${state.url}\n${state.title}\n${body}`;
}

export function pageStateChanged(before: PageState, after: PageState): boolean {
	return pageStateFingerprint(before) !== pageStateFingerprint(after);
}

export function formatPageState(state: PageState, maxChars = 6000): string {
	const text =
		state.text.length > maxChars ? `${state.text.slice(0, maxChars)}\n…[clipped]` : state.text;
	return `URL: ${state.url}\nTitle: ${state.title}\n\n${text}`;
}

/**
 * Tool result after click/type/navigate: short verdict + after-state (source of truth).
 */
export function formatActionWithObservation(opts: {
	actionLine: string;
	before: PageState;
	after: PageState;
	/** When false, skip unchanged warning (e.g. navigate always shows after-state). */
	warnIfUnchanged?: boolean;
}): string {
	const changed = pageStateChanged(opts.before, opts.after);
	const warn = opts.warnIfUnchanged !== false;
	const lines = [opts.actionLine];
	if (changed) {
		lines.push('UI changed after action.');
	} else if (warn) {
		lines.push(
			'UI UNCHANGED after action — repeating the same selector will not help. Inspect page state / app code, or try a different action.'
		);
	} else {
		lines.push('Post-action page state:');
	}
	lines.push('', '### After (page state — source of truth)', formatPageState(opts.after));
	return lines.join('\n');
}
