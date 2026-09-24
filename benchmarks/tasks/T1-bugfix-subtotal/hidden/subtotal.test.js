'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCart, addItem, subtotal, total, buildInvoice } = require('../src/index.js');

test('hidden: subtotal counts every item', () => {
	const cart = createCart();
	addItem(cart, { sku: 'A', price: 10 });
	addItem(cart, { sku: 'B', price: 2.5, qty: 2 });
	addItem(cart, { sku: 'C', price: 1.25, qty: 4 });
	assert.equal(subtotal(cart), 20);
});

test('hidden: empty cart subtotal is 0', () => {
	assert.equal(subtotal(createCart()), 0);
});

test('hidden: single item still works', () => {
	assert.equal(subtotal(addItem(createCart(), { sku: 'A', price: 3, qty: 3 })), 9);
});

test('hidden: totals and invoice agree', () => {
	const cart = createCart({ tier: 'silver' });
	addItem(cart, { sku: 'A', price: 30 });
	addItem(cart, { sku: 'B', price: 70 });
	assert.equal(total(cart, 'PT'), buildInvoice(cart, 'PT').total);
	assert.equal(total(cart, 'PT'), 119.31);
});
