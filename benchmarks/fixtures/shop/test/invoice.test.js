'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCart, addItem, buildInvoice, formatInvoice, shippingCost } = require('../src/index.js');

test('invoice for a gold customer in Spain', () => {
	const cart = createCart({ tier: 'gold' });
	addItem(cart, { sku: 'LAMP', price: 40 });
	addItem(cart, { sku: 'BULB', price: 5, qty: 2 });
	const inv = buildInvoice(cart, 'ES');
	assert.equal(inv.subtotal, 50);
	assert.equal(inv.discount, 2.5);
	assert.equal(inv.net, 47.5);
	assert.equal(inv.tax, 9.98);
	assert.equal(inv.total, 57.48);
});

test('formatted invoice shows the total', () => {
	const cart = addItem(createCart(), { sku: 'LAMP', price: 40 });
	const text = formatInvoice(buildInvoice(cart, 'DE'));
	assert.match(text, /Total: 47\.60 EUR/);
});

test('shipping is free above the regional threshold', () => {
	assert.equal(shippingCost(39.99, 'PT'), 3.5);
	assert.equal(shippingCost(40, 'PT'), 0);
	assert.equal(shippingCost(500, 'XX'), 12);
});
