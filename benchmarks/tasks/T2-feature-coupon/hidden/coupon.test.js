'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shop = require('../src/index.js');
const coupons = require('../src/pricing/coupons.js');

const NOW = new Date('2026-01-15T12:00:00Z');

function cartOf(amount) {
	return shop.addItem(shop.createCart(), { sku: 'X', price: amount });
}

test('hidden: applyCoupon is exported from the coupons module and index', () => {
	assert.equal(typeof coupons.applyCoupon, 'function');
	assert.equal(typeof shop.applyCoupon, 'function');
});

test('hidden: percent coupon', () => {
	assert.equal(shop.applyCoupon(cartOf(50), 'WELCOME10', NOW), 5);
	assert.equal(shop.applyCoupon(cartOf(33.33), 'WELCOME10', NOW), 3.33);
});

test('hidden: codes are case-insensitive', () => {
	assert.equal(shop.applyCoupon(cartOf(50), 'welcome10', NOW), 5);
});

test('hidden: fixed coupon is capped at the subtotal', () => {
	assert.equal(shop.applyCoupon(cartOf(50), 'FIVEOFF', NOW), 5);
	assert.equal(shop.applyCoupon(cartOf(3), 'FIVEOFF', NOW), 3);
});

test('hidden: expired and unknown coupons throw', () => {
	assert.throws(() => shop.applyCoupon(cartOf(50), 'OLD20', NOW), { message: 'EXPIRED_COUPON' });
	assert.throws(() => shop.applyCoupon(cartOf(50), 'NOPE', NOW), { message: 'INVALID_COUPON' });
});

test('hidden: coupon is valid on its expiry day', () => {
	assert.equal(shop.applyCoupon(cartOf(100), 'OLD20', new Date('2020-01-01T18:00:00Z')), 20);
});

test('hidden: applyCoupon does not mutate the cart', () => {
	const cart = cartOf(50);
	const before = JSON.stringify(cart);
	shop.applyCoupon(cart, 'WELCOME10', NOW);
	assert.equal(JSON.stringify(cart), before);
});
