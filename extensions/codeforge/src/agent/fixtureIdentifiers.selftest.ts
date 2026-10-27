/**
 * Fixture identifiers must come from text/files, never a hand-written bench name list.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	extractIdentifiersFromFiles,
	extractIdentifiersFromText,
	firstMatchingToken,
} from './fixtureIdentifiers';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

const text = `
Implement applyCoupon from docs/pricing.md.
export function applyCoupon(cart, code) {}
path: src/pricing/coupons.js
`;
const ids = extractIdentifiersFromText(text);
assert(ids.includes('applyCoupon'), 'camelCase symbol extracted');
assert(ids.includes('docs/pricing.md') || ids.includes('src/pricing/coupons.js'), 'path extracted');
assert(!ids.includes('function'), 'stopword skipped');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fixture-ids-'));
const file = path.join(dir, 'task.json');
fs.writeFileSync(
	file,
	JSON.stringify({ prompt: 'Call loadCoupons then applyCoupon from src/index.js' }),
	'utf8'
);
const fromFiles = extractIdentifiersFromFiles([file]);
assert(fromFiles.includes('applyCoupon'), 'file extract finds applyCoupon');
assert(fromFiles.includes('loadCoupons'), 'file extract finds loadCoupons');

assert(firstMatchingToken('use applyCoupon here', ['applyCoupon']) === 'applyCoupon', 'token match');
assert(firstMatchingToken('use apply elsewhere', ['applyCoupon']) === undefined, 'no false match');

fs.rmSync(dir, { recursive: true, force: true });
console.log('fixtureIdentifiers.selftest: ok');
