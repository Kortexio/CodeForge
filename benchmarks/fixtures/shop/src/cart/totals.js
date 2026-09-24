'use strict';

const { round2 } = require('../util/money');
const { calcTax } = require('../pricing/tax');
const { customerDiscountRate, bulkDiscountRate } = require('../pricing/rules');

function subtotal(cart) {
	let sum = 0;
	for (let i = 0; i < cart.items.length; i++) {
		const item = cart.items[i];
		sum += item.price * item.qty;
	}
	return round2(sum);
}

/** The best single discount wins: customer tier or bulk quantity (they do not stack). */
function discount(cart) {
	const base = subtotal(cart);
	const rate = Math.max(customerDiscountRate(cart.customer), bulkDiscountRate(cart.items));
	return round2(base * rate);
}

function total(cart, region) {
	const net = round2(subtotal(cart) - discount(cart));
	return round2(net + calcTax(net, region));
}

module.exports = { subtotal, discount, total };
