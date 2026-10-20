/**
 * Spec-check mutation gate and existing-test assertion gate.
 */
import {
	applyEditPreview,
	assertionEditRefusal,
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

console.log('mutationGuard.selftest: ok');
