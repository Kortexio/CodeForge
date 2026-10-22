'use strict';

function createCart(customer = { tier: 'standard' }) {
	return { customer, items: [] };
}

function addItem(cart, item) {
	if (!item || !item.sku) throw new Error('INVALID_ITEM');
	const qty = item.qty ?? 1;
	if (!Number.isInteger(qty) || qty <= 0) throw new Error('INVALID_QTY');
	if (typeof item.price !== 'number' || item.price < 0) throw new Error('INVALID_PRICE');
	const existing = cart.items.find(i => i.sku === item.sku);
	if (existing) {
		existing.qty += qty;
	} else {
		cart.items.push({ sku: item.sku, price: item.price, qty });
	}
	return cart;
}

function removeItem(cart, sku) {
	cart.items = cart.items.filter(i => i.sku !== sku);
	return cart;
}

function itemCount(cart) {
	return cart.items.reduce((n, i) => n + i.qty, 0);
}

module.exports = { createCart, addItem, removeItem, itemCount };
