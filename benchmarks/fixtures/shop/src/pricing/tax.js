'use strict';

const { round2 } = require('../util/money');

const RATES = { PT: 0.23, ES: 0.21, DE: 0.19, FR: 0.2 };

function taxRate(region) {
	return RATES[String(region || '').toUpperCase()] ?? 0;
}

function calcTax(amount, region) {
	return round2(amount * taxRate(region));
}

module.exports = { RATES, taxRate, calcTax };
