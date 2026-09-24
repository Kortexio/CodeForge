'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shop = require('../src/index.js');
const rules = require('../src/pricing/rules.js');

test('hidden: VIP customers get 15%', () => {
	assert.equal(shop.customerDiscountRate({ tier: 'vip' }), 0.15);
	const cart = shop.addItem(shop.createCart({ tier: 'vip' }), { sku: 'X', price: 100 });
	assert.equal(shop.discount(cart), 15);
});

test('hidden: other tiers are unchanged', () => {
	assert.equal(shop.customerDiscountRate({ tier: 'standard' }), 0);
	assert.equal(shop.customerDiscountRate({ tier: 'silver' }), 0.03);
	assert.equal(shop.customerDiscountRate({ tier: 'gold' }), 0.05);
	assert.equal(shop.customerDiscountRate({ tier: 'vip', blocked: true }), 0);
});

test('hidden: loyalty points are not discounts (decoy 0.1 untouched)', () => {
	assert.equal(rules.LOYALTY_RATE, 0.1);
	assert.equal(rules.loyaltyPoints(100, 'vip'), 20);
});

test('hidden: best single rate wins (VIP 15% beats 12% bulk)', () => {
	const cart = shop.addItem(shop.createCart({ tier: 'vip' }), { sku: 'X', price: 1, qty: 60 });
	assert.equal(shop.discount(cart), 9);
});
