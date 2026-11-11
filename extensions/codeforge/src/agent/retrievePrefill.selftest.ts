/**
 * Guards: start/compact retrieve must stay live — never hardcode includeRetrieve: false.
 */
import * as fs from 'fs';
import * as path from 'path';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const agentLoopPath = path.join(__dirname, 'agentLoop.ts');
const src = fs.readFileSync(agentLoopPath, 'utf8');

assert(
	!/includeRetrieve:\s*false/.test(src),
	'agentLoop must not hardcode includeRetrieve: false (start + compact use true)'
);
assert(
	/includeRetrieve:\s*true/.test(src),
	'agentLoop must set includeRetrieve: true'
);
assert(
	/Start context \(retrieve \+ IDE\)/.test(src),
	'agentLoop must inject a start retrieve + IDE user block'
);
assert(
	/retrieveK:\s*4/.test(src),
	'start/compact retrieve uses k=4'
);

console.log('retrievePrefill.selftest: ok');
