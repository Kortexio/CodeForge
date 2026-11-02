/**
 * Structural mutation gates. Path and file-diff only — not user-text intent.
 *
 * - During the spec edge-case check, no test-dir changes and no new workspace files.
 * - A test file that was on disk when the turn started is the spec: not edited, rewritten or deleted.
 * - An edit/write of a test file that already existed must keep every assertion line.
 */

import * as fs from 'fs';
import * as path from 'path';

const MUTATING = new Set(['write', 'edit', 'delete', 'rename', 'apply_patch']);

/** True when `rel` is on disk under `root` and was last modified before `turnStartMs`. */
export function existedBeforeTurn(root: string | undefined, rel: string, turnStartMs: number): boolean {
	if (!root || !rel) return false;
	try {
		return fs.statSync(path.resolve(root, rel)).mtimeMs < turnStartMs;
	} catch {
		return false;
	}
}

export function existingTestMutationRefusal(input: {
	/** codeforge.ai.protectExistingTests (default true). */
	enabled: boolean;
	tool: string;
	path: string;
	isTestPath: boolean;
	/** The file was on disk before this turn started (not created by this turn). */
	existedAtTurnStart: boolean;
}): string | undefined {
	if (!input.enabled || !MUTATING.has(input.tool)) return undefined;
	if (!input.isTestPath || !input.existedAtTurnStart) return undefined;
	return [
		`Not applied: ${input.path} is a test file that existed before this turn. Existing tests are the spec and stay unchanged.`,
		'Make the change in the source files so these tests pass.',
		'Add a new test file only when the user asked for tests.',
	].join(' ');
}

export function specCheckMutationRefusal(input: {
	/** True after the one-shot spec edge-case note was sent. */
	active: boolean;
	tool: string;
	isTestPath: boolean;
	/** False when write/apply_patch would create a path that is not on disk. */
	fileExists: boolean;
}): string | undefined {
	if (!input.active || !MUTATING.has(input.tool)) return undefined;
	if (input.isTestPath) {
		return [
			'Not applied: the spec edge-case check does not create, edit, or delete files under a test directory.',
			'Run the existing test suite.',
			'A one-off check script goes outside the workspace (the OS temp dir) and is deleted before finishing.',
			'If a boundary fails, edit the source file that already changed.',
		].join(' ');
	}
	if ((input.tool === 'write' || input.tool === 'apply_patch') && !input.fileExists) {
		return [
			'Not written: during the spec edge-case check, do not add files inside the workspace.',
			'Put a one-off script in the OS temp dir and delete it before finishing.',
			'If a boundary fails, edit the source file that already changed.',
		].join(' ');
	}
	if (input.tool === 'delete') {
		return 'Not deleted: during the spec edge-case check, do not delete workspace files. Delete only a temp script outside the workspace.';
	}
	return undefined;
}

/** Preview of an edit. Undefined when old_string is not in the file (the edit tool reports that). */
export function applyEditPreview(
	before: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): string | undefined {
	if (!oldString || !before.includes(oldString)) return undefined;
	return replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
}

function isAssertionLine(trimmed: string): boolean {
	if (!trimmed || /^(\/\/|#|\*|<!--)/.test(trimmed)) return false;
	return /\bAssert\./.test(trimmed) || /\b(assert|expect)\s*\(/.test(trimmed) || /\bassert\./i.test(trimmed);
}

function assertionCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!isAssertionLine(trimmed)) continue;
		counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
	}
	return counts;
}

/** Assertion lines present in `before` that are missing or altered in `after`. */
export function missingAssertions(before: string, after: string): string[] {
	const prior = assertionCounts(before);
	const next = assertionCounts(after);
	const missing: string[] = [];
	for (const [line, count] of prior) {
		const gone = count - (next.get(line) ?? 0);
		for (let i = 0; i < gone; i++) missing.push(line);
	}
	return missing;
}

export function assertionEditRefusal(path: string, missing: string[]): string | undefined {
	if (!missing.length) return undefined;
	const shown = missing.slice(0, 4).map(l => `  ${l}`).join('\n');
	const more = missing.length > 4 ? `\n  …${missing.length - 4} more` : '';
	return [
		`Not applied: ${path} already existed, and an assertion changed or disappeared:`,
		shown + more,
		'Existing assertions stay. Fix the source so they pass, or add a new test. Do not change assertions to make the suite pass.',
	].join('\n');
}
