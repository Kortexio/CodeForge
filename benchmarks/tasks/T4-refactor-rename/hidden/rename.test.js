'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shop = require('../src/index.js');
const tax = require('../src/pricing/tax.js');

test('hidden: computeTax is exported from tax module and index', () => {
	assert.equal(typeof tax.computeTax, 'function');
	assert.equal(typeof shop.computeTax, 'function');
});

test('hidden: behaviour is unchanged', () => {
	assert.equal(shop.computeTax(100, 'PT'), 23);
	assert.equal(shop.computeTax(47.5, 'es'), 9.98);
	assert.equal(shop.computeTax(10, 'XX'), 0);
});

test('hidden: totals and invoices still use the tax', () => {
	const cart = shop.addItem(shop.createCart(), { sku: 'LAMP', price: 40 });
	assert.equal(shop.total(cart, 'DE'), 47.6);
	assert.equal(shop.buildInvoice(cart, 'DE').tax, 7.6);
});
