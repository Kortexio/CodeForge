'use strict';

const cart = require('./cart/cart');
const totals = require('./cart/totals');
const tax = require('./pricing/tax');
const rules = require('./pricing/rules');
const coupons = require('./pricing/coupons');
const invoice = require('./checkout/invoice');

module.exports = {
	createCart: cart.createCart,
	addItem: cart.addItem,
	removeItem: cart.removeItem,
	itemCount: cart.itemCount,
	subtotal: totals.subtotal,
	discount: totals.discount,
	total: totals.total,
	calcTax: tax.calcTax,
	taxRate: tax.taxRate,
	customerDiscountRate: rules.customerDiscountRate,
	bulkDiscountRate: rules.bulkDiscountRate,
	shippingCost: rules.shippingCost,
	loadCoupons: coupons.loadCoupons,
	buildInvoice: invoice.buildInvoice,
	formatInvoice: invoice.formatInvoice,
};
