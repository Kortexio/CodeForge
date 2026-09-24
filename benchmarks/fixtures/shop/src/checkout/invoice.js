'use strict';

const { round2, formatEuro } = require('../util/money');
const { subtotal, discount } = require('../cart/totals');
const { calcTax, taxRate } = require('../pricing/tax');

function buildInvoice(cart, region) {
	const lines = cart.items.map(i => ({
		sku: i.sku,
		qty: i.qty,
		unit: i.price,
		amount: round2(i.price * i.qty),
	}));
	const sub = subtotal(cart);
	const disc = discount(cart);
	const net = round2(sub - disc);
	const tax = calcTax(net, region);
	return {
		lines,
		subtotal: sub,
		discount: disc,
		net,
		taxRate: taxRate(region),
		tax,
		total: round2(net + tax),
	};
}

function formatInvoice(invoice) {
	const rows = invoice.lines.map(
		l => `${l.sku.padEnd(12)} ${String(l.qty).padStart(3)} x ${formatEuro(l.unit)} = ${formatEuro(l.amount)}`
	);
	return [
		...rows,
		`Subtotal: ${formatEuro(invoice.subtotal)}`,
		`Discount: -${formatEuro(invoice.discount)}`,
		`Tax (${Math.round(invoice.taxRate * 100)}%): ${formatEuro(invoice.tax)}`,
		`Total: ${formatEuro(invoice.total)}`,
	].join('\n');
}

module.exports = { buildInvoice, formatInvoice };
