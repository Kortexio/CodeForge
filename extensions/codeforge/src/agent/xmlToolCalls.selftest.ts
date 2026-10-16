/**
 * XML → tool_calls lift (Qwen/Hermes markup).
 */
import { looksLikeXmlToolMarkup, parseXmlToolCalls } from './xmlToolCalls';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const sample = `I'll run the Vite dev server for you. Let me check the package.json first.

<tool_call>
<function=read>
<parameter=path>
c:\\Users\\vitor\\source\\repos\\Kortexio\\LocalTest\\package.json
</parameter>
</function>
</tool_call>
`;

assert(looksLikeXmlToolMarkup(sample), 'detect sample');
const calls = parseXmlToolCalls(sample);
assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
assert(calls[0].function.name === 'read', 'name read');
const args = JSON.parse(calls[0].function.arguments) as { path: string };
assert(
	args.path.includes('LocalTest') && args.path.endsWith('package.json'),
	`path=${args.path}`
);

const multi = `<tool_call>
<function=edit>
<parameter=path>
src/a.ts
</parameter>
<parameter=old_string>
foo
</parameter>
<parameter=new_string>
bar
</parameter>
</function>
</tool_call>`;
const edits = parseXmlToolCalls(multi);
assert(edits.length === 1 && edits[0].function.name === 'edit', 'edit');
const eargs = JSON.parse(edits[0].function.arguments) as Record<string, string>;
assert(eargs.old_string === 'foo' && eargs.new_string === 'bar', 'edit args');

const jsonInside = `<tool_call>
{"name":"shell","arguments":{"command":"npm run dev"}}
</tool_call>`;
const sh = parseXmlToolCalls(jsonInside);
assert(sh.length === 1 && sh[0].function.name === 'shell', 'json-in-xml');

assert(parseXmlToolCalls('just prose').length === 0, 'no false positive');

console.log('xmlToolCalls.selftest: ok');
