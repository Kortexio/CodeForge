/**
 * Unit checks for tolerant edit matching (run via compiled out/).
 */
import { applyEdit, closestWindow, normalizeForMatch, stripReadLineNumbers } from './editTool';

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
assert(!miss.ok && /^\s*\d+\|/m.test(miss.error), 'miss shows numbered window');

const win = closestWindow('aaa\nbbb\nccc\nddd\neee\n', 'bbb', 1);
assert(win.includes('  1|aaa') && win.includes('  2|bbb') && win.includes('  3|ccc'), 'closestWindow radius');

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

// Indent-tolerant: spaces in file, tabs in old_string — single match, re-indent new_string.
const indentFile = ['function f() {', '\tif (true) {', '\t\treturn 1;', '\t}', '}', ''].join('\n');
const indentEdit = applyEdit(
	indentFile,
	'  if (true) {\n    return 1;\n  }',
	'  if (true) {\n    return 2;\n  }'
);
assert(indentEdit.ok, 'indent-tolerant match');
assert(indentEdit.ok && indentEdit.text.includes('\t\treturn 2;'), 're-indent new_string to file tabs');

console.log('editTool.selftest: ok');
