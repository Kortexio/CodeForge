'use strict';

function round2(n) {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatEuro(n) {
	return `${round2(n).toFixed(2)} EUR`;
}

module.exports = { round2, formatEuro };
