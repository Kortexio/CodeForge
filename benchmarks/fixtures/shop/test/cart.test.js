'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCart, addItem, removeItem, itemCount, subtotal, discount, total } = require('../src/index.js');

test('addItem merges the same sku', () => {
	const cart = createCart();
	addItem(cart, { sku: 'PEN', price: 1.5, qty: 2 });
	addItem(cart, { sku: 'PEN', price: 1.5, qty: 3 });
	assert.equal(cart.items.length, 1);
	assert.equal(itemCount(cart), 5);
});

test('addItem rejects invalid quantities', () => {
	assert.throws(() => addItem(createCart(), { sku: 'PEN', price: 1, qty: 0 }), { message: 'INVALID_QTY' });
});

test('subtotal of a single item', () => {
	const cart = addItem(createCart(), { sku: 'MUG', price: 7.25, qty: 2 });
	assert.equal(subtotal(cart), 14.5);
});

test('subtotal of several items', () => {
	const cart = createCart();
	addItem(cart, { sku: 'MUG', price: 7.25, qty: 2 });
	addItem(cart, { sku: 'PEN', price: 1.5, qty: 4 });
	addItem(cart, { sku: 'BAG', price: 12, qty: 1 });
	assert.equal(subtotal(cart), 32.5);
});

test('removeItem drops the sku', () => {
	const cart = createCart();
	addItem(cart, { sku: 'MUG', price: 7.25 });
	addItem(cart, { sku: 'PEN', price: 1.5 });
	removeItem(cart, 'MUG');
	assert.deepEqual(cart.items.map(i => i.sku), ['PEN']);
});

test('bulk discount applies from 10 units', () => {
	const cart = addItem(createCart(), { sku: 'PEN', price: 2, qty: 10 });
	assert.equal(discount(cart), 1);
});

test('total adds regional VAT to the net amount', () => {
	const cart = createCart();
	addItem(cart, { sku: 'MUG', price: 10 });
	addItem(cart, { sku: 'BAG', price: 20 });
	assert.equal(total(cart, 'PT'), 36.9);
	assert.equal(total(cart, 'XX'), 30);
});
