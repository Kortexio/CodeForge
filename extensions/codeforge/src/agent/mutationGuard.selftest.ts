/**
 * Spec-check mutation gate and existing-test assertion gate.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	applyEditPreview,
	assertionEditRefusal,
	existedBeforeTurn,
	existingTestMutationRefusal,
	missingAssertions,
	specCheckMutationRefusal,
} from './mutationGuard';

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

assert(
	specCheckMutationRefusal({ active: false, tool: 'write', isTestPath: true, fileExists: false }) === undefined,
	'inactive: no refusal'
);
assert(
	/test directory/.test(
		specCheckMutationRefusal({ active: true, tool: 'edit', isTestPath: true, fileExists: true }) ?? ''
	),
	'spec check refuses a test edit'
);
assert(
	/do not add files inside the workspace/.test(
		specCheckMutationRefusal({ active: true, tool: 'write', isTestPath: false, fileExists: false }) ?? ''
	),
	'spec check refuses a new workspace file'
);
assert(
	specCheckMutationRefusal({ active: true, tool: 'edit', isTestPath: false, fileExists: true }) === undefined,
	'spec check allows editing source that already exists'
);
assert(
	/do not delete workspace files/.test(
		specCheckMutationRefusal({ active: true, tool: 'delete', isTestPath: false, fileExists: true }) ?? ''
	),
	'spec check refuses delete'
);
assert(
	specCheckMutationRefusal({ active: true, tool: 'shell', isTestPath: false, fileExists: false }) === undefined,
	'shell is not a file mutation'
);

const before = [
	'\t[Fact]',
	'\tpublic void Total_adds_regional_vat()',
	'\t{',
	'\t\tAssert.Equal(30m, Totals.Subtotal(cart));',
	'\t\tAssert.Equal(3m, Coupons.ApplyCoupon(cart, "WELCOME10"));',
	'\t}',
].join('\n');
const weakened = before.replace('Assert.Equal(30m, Totals.Subtotal(cart));', 'Assert.Equal(20m, Totals.Subtotal(cart));');
const gone = missingAssertions(before, weakened);
assert(gone.length === 1 && /30m/.test(gone[0]), 'changed assertion is missing');
assert(/Existing assertions stay/.test(assertionEditRefusal('tests/CartTests.cs', gone) ?? ''), 'refusal names the rule');
assert(assertionEditRefusal('tests/CartTests.cs', []) === undefined, 'no missing: no refusal');

const added = `${before}\n\t\tAssert.Equal(0.15m, PricingRules.CustomerDiscountRate(cart));`;
assert(missingAssertions(before, added).length === 0, 'adding an assertion is allowed');

const preview = applyEditPreview(before, 'Assert.Equal(30m, Totals.Subtotal(cart));', 'Assert.Equal(20m, Totals.Subtotal(cart));', false);
assert(preview !== undefined && missingAssertions(before, preview).length === 1, 'preview feeds the gate');
assert(applyEditPreview(before, 'not in file', 'x', false) === undefined, 'missing old_string is left to the edit tool');

const cs2Append = {
	enabled: true,
	tool: 'edit',
	path: 'tests/Acme.Billing.Tests/CartTests.cs',
	isTestPath: true,
	existedAtTurnStart: true,
};
assert(
	existingTestMutationRefusal(cs2Append) === undefined && existingTestMutationRefusal({ ...cs2Append, tool: 'write' }) === undefined,
	'editing a pre-existing test file is left to the assertion check'
);
assert(
	/existed before this turn/.test(existingTestMutationRefusal({ ...cs2Append, tool: 'delete' }) ?? ''),
	'deleting a pre-existing test file is refused'
);
assert(
	existingTestMutationRefusal({ ...cs2Append, tool: 'rename' }) !== undefined,
	'renaming a pre-existing test file is refused'
);

const renamedBefore = 'assert.strictEqual(calcTax(100), 23);\nexpect(calcTax(0)).toBe(0);';
const renamedAfter = 'assert.strictEqual(computeTax(100), 23);\nexpect(computeTax(0)).toBe(0);';
assert(missingAssertions(renamedBefore, renamedAfter).length === 2, 'without the rename list both lines are missing');
assert(missingAssertions(renamedBefore, renamedAfter, ['calcTax']).length === 0, 'following a source rename keeps the assertions');
assert(
	missingAssertions(renamedBefore, 'assert.strictEqual(computeTax(100), 25);\nexpect(computeTax(0)).toBe(0);', ['calcTax']).length === 1,
	'a rename does not excuse a changed expected value'
);
assert(
	missingAssertions(renamedBefore, renamedAfter.replace(/computeTax/g, 'otherFn'), ['unrelated']).length === 2,
	'only names removed from the source count as renames'
);
assert(
	existingTestMutationRefusal({ ...cs2Append, existedAtTurnStart: false }) === undefined,
	'a test file created this turn may be edited'
);
assert(
	existingTestMutationRefusal({ ...cs2Append, isTestPath: false, path: 'src/Acme.Billing/Coupons.cs' }) === undefined,
	'source files are not affected'
);
assert(existingTestMutationRefusal({ ...cs2Append, enabled: false }) === undefined, 'setting off: allowed');
assert(existingTestMutationRefusal({ ...cs2Append, tool: 'read' }) === undefined, 'reads are not mutations');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mutation-guard-'));
try {
	fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
	fs.writeFileSync(path.join(tmpRoot, 'tests', 'Old.cs'), '// old');
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(tmpRoot, 'tests', 'Old.cs'), past, past);
	const turnStart = Date.now();
	fs.writeFileSync(path.join(tmpRoot, 'tests', 'New.cs'), '// new');
	fs.utimesSync(path.join(tmpRoot, 'tests', 'New.cs'), new Date(turnStart + 1000), new Date(turnStart + 1000));
	assert(existedBeforeTurn(tmpRoot, 'tests/Old.cs', turnStart), 'file modified before the turn existed');
	assert(!existedBeforeTurn(tmpRoot, 'tests/New.cs', turnStart), 'file written during the turn is new');
	assert(!existedBeforeTurn(tmpRoot, 'tests/Missing.cs', turnStart), 'missing file did not exist');
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('mutationGuard.selftest: ok');
