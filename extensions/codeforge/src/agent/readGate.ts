/**
 * Read-before-edit gate: pure decision + remedy formatting.
 * State is explicit (no module globals).
 */

import { canonicalizePathKey } from './readMemory';
import { closestWindow, numberedExcerpt } from './editTool';

export type ReadGateState = {
	/** Paths read (or remedied) this turn — satisfies mutate gates. */
	readThisTurn: Set<string>;
	/** Paths seen earlier in the session (preload / prior reads). */
	readPathsSeen: Set<string>;
};

export function createReadGateState(): ReadGateState {
	return {
		readThisTurn: new Set(),
		readPathsSeen: new Set(),
	};
}

export function markReadThisTurn(state: ReadGateState, pathKey: string): void {
	const pk = canonicalizePathKey(pathKey);
	if (!pk) return;
	state.readThisTurn.add(pk);
	state.readPathsSeen.add(pk);
}

export function pathSeenBefore(state: ReadGateState, pathKey: string): boolean {
	const pk = canonicalizePathKey(pathKey);
	if (!pk) return false;
	if (state.readPathsSeen.has(pk)) return true;
	return [...state.readPathsSeen].some(k => k === pk || k.endsWith('/' + pk));
}

export type ReadGateDecision =
	| { allow: true }
	| {
			allow: false;
			/** Mark this path as read this turn after attaching the remedy. */
			markPath: string;
			/** Numbered excerpt to append (empty when file missing). */
			excerpt: string;
			message: string;
	  };

export type ReadGateFileText = string | undefined;

/**
 * Decide whether edit/apply_patch may proceed (must have read this turn).
 */
export function decideEditReadGate(
	state: ReadGateState,
	pathArg: string,
	fileText: ReadGateFileText,
	oldString?: string
): ReadGateDecision {
	const pk = canonicalizePathKey(pathArg);
	if (!pk || state.readThisTurn.has(pk)) {
		return { allow: true };
	}
	let excerpt = '';
	if (fileText !== undefined) {
		excerpt = oldString
			? closestWindow(fileText, oldString, 15)
			: numberedExcerpt(fileText, 120);
	}
	return {
		allow: false,
		markPath: pk,
		excerpt,
		message: [
			'Not run: you must copy old_string from the file. Current contents (now marked as read this turn):',
			excerpt || '(file missing or unreadable)',
		].join('\n'),
	};
}

/**
 * Decide whether write may overwrite a previously-seen file without a read this turn.
 */
export function decideWriteReadGate(
	state: ReadGateState,
	pathArg: string,
	fileText: ReadGateFileText
): ReadGateDecision {
	const pk = canonicalizePathKey(pathArg);
	if (!pk) return { allow: true };
	const alreadySeen = pathSeenBefore(state, pk);
	if (!alreadySeen || state.readThisTurn.has(pk)) {
		return { allow: true };
	}
	const excerpt = fileText !== undefined ? numberedExcerpt(fileText, 120) : '';
	return {
		allow: false,
		markPath: pk,
		excerpt,
		message: [
			'Not run: you must copy old_string from the file. Current contents (now marked as read this turn):',
			excerpt || '(file missing or unreadable)',
		].join('\n'),
	};
}

/** Apply a refuse decision: mark the path as read this turn. */
export function applyReadGateRemedy(state: ReadGateState, decision: ReadGateDecision): void {
	if (decision.allow) return;
	markReadThisTurn(state, decision.markPath);
}
