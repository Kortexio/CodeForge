/**
 * Unit checks for tolerant edit matching (run via compiled out/).
 */
import { applyEdit, normalizeForMatch, stripReadLineNumbers } from './editTool';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(stripReadLineNumbers('  12|foo\n  13|bar') === 'foo\nbar', 'strip line nums');
assert(stripReadLineNumbers('foo\nbar') === 'foo\nbar', 'keep plain');
assert(normalizeForMatch('\u201Chello\u201D') === '"hello"', 'smart quotes');

const crlfFile = 'line one\r\nline two\r\nline three\r\n';
const crlfEdit = applyEdit(crlfFile, 'line two', 'line TWO');
assert(crlfEdit.ok && crlfEdit.text.includes('\r\n'), 'preserve CRLF');

const smartFile = 'const s = "hello";\n';
const smartEdit = applyEdit(smartFile, 'const s = \u201Chello\u201D;', 'const s = "hi";');
assert(smartEdit.ok && smartEdit.text.includes('"hi"'), 'unicode quote tier');

const numbered = applyEdit(
	'function a() {\n  return 1;\n}\n',
	'   1|function a() {\n   2|  return 1;\n   3|}',
	'function a() {\n  return 2;\n}'
);
assert(numbered.ok && numbered.text.includes('return 2'), 'strip read prefixes');

const miss = applyEdit('abc\n', 'zzz', 'yyy');
assert(!miss.ok && /not found/i.test(miss.error), 'miss error');

const multi = applyEdit('aa\nxx\naa\n', 'aa', 'bb', false);
assert(!multi.ok && /matches 2/i.test(multi.error), 'ambiguous');

const all = applyEdit('aa\nxx\naa\n', 'aa', 'bb', true);
assert(all.ok && all.count === 2, 'replace_all');

// Desired text already on disk — treat as success so the model stops retrying.
const alreadyFile = [
	'  private startGame(): void {',
	'    this.gameLoop();',
	'  }',
	'',
	'  /** restart */',
	'  private restartGame(): void {',
	'',
].join('\n');
const already = applyEdit(
	alreadyFile,
	'    this.gameLoop();\n  /** restart */\n  private restartGame(): void {',
	'    this.gameLoop();\n  }\n\n  /** restart */\n  private restartGame(): void {'
);
assert(already.ok && already.alreadyApplied === true, 'already applied when new_string present');
assert(already.ok && already.text === alreadyFile, 'already applied does not rewrite');

console.log('editTool.selftest: ok');
