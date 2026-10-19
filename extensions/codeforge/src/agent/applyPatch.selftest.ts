/**
 * Unit checks for apply_patch parser/applier.
 */
import { applyUpdateToText, modelUsesApplyPatch, parsePatch } from './applyPatch';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(modelUsesApplyPatch('gpt-5.1'), 'gpt uses patch');
assert(!modelUsesApplyPatch('gpt-4o'), 'gpt-4 excluded');
assert(!modelUsesApplyPatch('qwen3.6-35b'), 'qwen no patch');
assert(!modelUsesApplyPatch('gpt-oss-120b'), 'oss no patch');

const parsed = parsePatch(`*** Begin Patch
*** Update File: src/a.ts
@@
-const x = 1;
+const x = 2;
*** End Patch`);
assert(parsed.ok && parsed.hunks.length === 1 && parsed.hunks[0].type === 'update', 'parse update');

const file = 'const x = 1;\nconst y = 2;\n';
if (parsed.ok && parsed.hunks[0].type === 'update') {
	const r = applyUpdateToText(file, parsed.hunks[0].chunks);
	assert(r.ok && r.text.includes('const x = 2'), 'apply update');
}

const add = parsePatch(`*** Begin Patch
*** Add File: hi.ts
+export const hi = 1;
*** End Patch`);
assert(add.ok && add.hunks[0].type === 'add', 'parse add');

const bad = parsePatch('');
assert(!bad.ok, 'empty fails');

console.log('applyPatch.selftest: ok');
