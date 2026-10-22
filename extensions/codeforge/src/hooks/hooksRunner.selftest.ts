import { quoteShellArg } from './hooksShellQuote';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(quoteShellArg('plain') === 'plain', 'plain arg unchanged');
assert(quoteShellArg('has space').includes('"'), 'spaces quoted on win');
assert(quoteShellArg('a&b').includes('"'), 'shell metachar quoted');

console.log('hooksRunner.selftest: ok');
