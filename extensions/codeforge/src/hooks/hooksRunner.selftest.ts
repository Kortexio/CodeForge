import { quoteShellArg } from './hooksShellQuote';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(quoteShellArg('plain') === 'plain', 'plain arg unchanged');
const spaced = quoteShellArg('has space');
assert(
	(spaced.startsWith('"') && spaced.endsWith('"')) || (spaced.startsWith("'") && spaced.endsWith("'")),
	'spaces quoted'
);
const meta = quoteShellArg('a&b');
assert(
	(meta.startsWith('"') && meta.endsWith('"')) || (meta.startsWith("'") && meta.endsWith("'")),
	'shell metachar quoted'
);

console.log('hooksRunner.selftest: ok');
