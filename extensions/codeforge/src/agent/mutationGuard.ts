/**
 * Structural mutation gates. Path and file-diff only — not user-text intent.
 *
 * - During the spec edge-case check, no test-dir changes and no new workspace files.
 * - A test file that was on disk when the turn started is the spec: not deleted or renamed.
 * - An edit/write of a test file that already existed must keep every assertion line
 *   (adding tests is fine; so is following a rename the turn made in the source).
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
	if (!input.enabled || (input.tool !== 'delete' && input.tool !== 'rename')) return undefined;
	if (!input.isTestPath || !input.existedAtTurnStart) return undefined;
	return [
		`Not applied: ${input.path} is a test file that existed before this turn, and its tests are part of the spec.`,
		'Keep the file. Fix the source so its tests pass; you may add tests to it or follow a rename you made in the source.',
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

/**
 * Assertion calls across test frameworks: assert*(…)/assert.x/Assert.X, assert!/assert_eq!,
 * expect(…), `assert x == y`, t.Error/t.Fatal, should/must chains.
 */
function isAssertionLine(trimmed: string): boolean {
	if (!trimmed || /^(\/\/|#(?!\[)|\*|<!--|--|;)/.test(trimmed)) return false;
	return (
		/\bassert\w*!?\s*[(.]/i.test(trimmed) ||
		/^assert\s+\S/.test(trimmed) ||
		/\bexpect\s*\(/.test(trimmed) ||
		/\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/.test(trimmed) ||
		/\.\s*(?:should|must)\w*\b/i.test(trimmed)
	);
}

export type ChangedFile = { path: string; before: string; after: string };

/**
 * Identifiers that were in a changed non-test file before this turn and are gone from it now
 * (renamed or removed). Plain tokens, so it works for any language.
 */
export function removedIdentifiers(changed: ChangedFile[], isTestPath: (p: string) => boolean): string[] {
	const tokens = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
	const out = new Set<string>();
	for (const c of changed) {
		if (isTestPath(c.path)) continue;
		const now = tokens(c.after);
		for (const t of tokens(c.before)) if (!now.has(t)) out.add(t);
	}
	return [...out];
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

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Assertion lines present in `before` that are missing or altered in `after`.
 * A line rewritten only by replacing names in `renamed` (removed from the source this turn)
 * with other identifiers counts as kept.
 */
export function missingAssertions(before: string, after: string, renamed: readonly string[] = []): string[] {
	const prior = assertionCounts(before);
	const next = assertionCounts(after);
	const missing: string[] = [];
	for (const [line, count] of prior) {
		const gone = count - (next.get(line) ?? 0);
		for (let i = 0; i < gone; i++) missing.push(line);
	}
	if (!missing.length || !renamed.length) return missing;
	const added: string[] = [];
	for (const [line, count] of next) {
		const extra = count - (prior.get(line) ?? 0);
		for (let i = 0; i < extra; i++) added.push(line);
	}
	const namePattern = new RegExp(
		`(?<![\\w$])(?:${renamed.map(escapeRegExp).join('|')})(?![\\w$])`,
		'g'
	);
	return missing.filter(line => {
		if (!namePattern.test(line)) return true;
		namePattern.lastIndex = 0;
		const shape = new RegExp(
			`^${line
				.split(namePattern)
				.map(escapeRegExp)
				.join('[A-Za-z_$][\\w$]*')}$`
		);
		const i = added.findIndex(a => shape.test(a));
		if (i < 0) return true;
		added.splice(i, 1);
		return false;
	});
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
