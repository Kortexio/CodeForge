'use strict';

/**
 * Pricing rules: bulk quantity, seasonal campaigns, loyalty points, shipping and customer tiers.
 *
 * Only `customerDiscountRate` and `bulkDiscountRate` feed the cart discount (see src/cart/totals.js).
 * Campaigns, loyalty and shipping are exposed for the storefront and reports.
 */

const { round2 } = require('../util/money');

// ---------------------------------------------------------------------------
// Bulk quantity
// ---------------------------------------------------------------------------

/** Tiers are evaluated from the largest threshold down; the first match wins. */
const BULK_TIERS = [
	{ minUnits: 50, rate: 0.12 },
	{ minUnits: 25, rate: 0.08 },
	{ minUnits: 10, rate: 0.05 },
];

function totalUnits(items) {
	return (items || []).reduce((n, i) => n + (i.qty || 0), 0);
}

function bulkDiscountRate(items) {
	const units = totalUnits(items);
	for (const tier of BULK_TIERS) {
		if (units >= tier.minUnits) {
			return tier.rate;
		}
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Seasonal campaigns
// ---------------------------------------------------------------------------

/**
 * Campaigns apply to a SKU prefix during a date window (inclusive).
 * They are shown as banners; the cart does not apply them automatically.
 */
const CAMPAIGNS = [
	{ id: 'spring', skuPrefix: 'GARDEN-', rate: 0.15, from: '2026-03-20', to: '2026-04-30' },
	{ id: 'summer', skuPrefix: 'BEACH-', rate: 0.2, from: '2026-06-21', to: '2026-08-31' },
	{ id: 'back-to-school', skuPrefix: 'BOOK-', rate: 0.1, from: '2026-09-01', to: '2026-09-30' },
	{ id: 'black-friday', skuPrefix: '', rate: 0.25, from: '2026-11-27', to: '2026-11-30' },
];

function parseDay(isoDay) {
	const [y, m, d] = String(isoDay).split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function isWithin(now, from, to) {
	const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return t >= parseDay(from).getTime() && t <= parseDay(to).getTime();
}

function activeCampaigns(now = new Date()) {
	return CAMPAIGNS.filter(c => isWithin(now, c.from, c.to));
}

function campaignRateFor(sku, now = new Date()) {
	let best = 0;
	for (const c of activeCampaigns(now)) {
		if (String(sku).startsWith(c.skuPrefix) && c.rate > best) {
			best = c.rate;
		}
	}
	return best;
}

function campaignBanner(now = new Date()) {
	const active = activeCampaigns(now);
	if (!active.length) return '';
	const top = active.reduce((a, b) => (b.rate > a.rate ? b : a));
	return `${top.id}: up to ${Math.round(top.rate * 100)}% off`;
}

// ---------------------------------------------------------------------------
// Loyalty points
// ---------------------------------------------------------------------------

/** Points earned per euro of net spend. */
const LOYALTY_RATE = 0.1;

/** Tier multipliers for loyalty points (not discounts). */
const LOYALTY_MULTIPLIER = {
	standard: 1,
	silver: 1.25,
	gold: 1.5,
	vip: 2,
};

function loyaltyPoints(netAmount, tier = 'standard') {
	const multiplier = LOYALTY_MULTIPLIER[tier] ?? 1;
	return Math.floor(netAmount * LOYALTY_RATE * multiplier);
}

function pointsToEuro(points) {
	// 100 points = 1 EUR voucher
	return round2(points / 100);
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

const SHIPPING = {
	PT: { flat: 3.5, freeFrom: 40 },
	ES: { flat: 4.9, freeFrom: 50 },
	DE: { flat: 6.9, freeFrom: 60 },
	FR: { flat: 5.9, freeFrom: 60 },
};

const DEFAULT_SHIPPING = { flat: 12, freeFrom: Infinity };

function shippingCost(netAmount, region) {
	const rule = SHIPPING[String(region || '').toUpperCase()] ?? DEFAULT_SHIPPING;
	return netAmount >= rule.freeFrom ? 0 : rule.flat;
}

function freeShippingGap(netAmount, region) {
	const rule = SHIPPING[String(region || '').toUpperCase()] ?? DEFAULT_SHIPPING;
	if (!Number.isFinite(rule.freeFrom)) return null;
	return round2(Math.max(0, rule.freeFrom - netAmount));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isKnownTier(tier) {
	return Object.prototype.hasOwnProperty.call(TIER_DISCOUNTS, tier);
}

function normalizeTier(customer) {
	const tier = String(customer?.tier || 'standard').toLowerCase();
	return isKnownTier(tier) ? tier : 'standard';
}

function describeRules() {
	return {
		bulk: BULK_TIERS.map(t => `${t.minUnits}+ units: ${Math.round(t.rate * 100)}%`),
		tiers: Object.entries(TIER_DISCOUNTS).map(([k, v]) => `${k}: ${Math.round(v * 100)}%`),
		campaigns: CAMPAIGNS.map(c => c.id),
	};
}

// ---------------------------------------------------------------------------
// Customer tiers
// ---------------------------------------------------------------------------

/**
 * Discount rate per customer tier, applied to the cart subtotal.
 * Business rules: docs/pricing.md ("Customer tiers").
 */
const SILVER_RATE = 0.03;
const GOLD_RATE = 0.05;
const VIP_RATE = 0.1;

const TIER_DISCOUNTS = {
	standard: 0,
	silver: SILVER_RATE,
	gold: GOLD_RATE,
	vip: VIP_RATE,
};

function customerDiscountRate(customer) {
	if (customer?.blocked) return 0;
	return TIER_DISCOUNTS[normalizeTier(customer)];
}

module.exports = {
	BULK_TIERS,
	CAMPAIGNS,
	LOYALTY_RATE,
	SHIPPING,
	TIER_DISCOUNTS,
	bulkDiscountRate,
	totalUnits,
	activeCampaigns,
	campaignRateFor,
	campaignBanner,
	loyaltyPoints,
	pointsToEuro,
	shippingCost,
	freeShippingGap,
	normalizeTier,
	describeRules,
	customerDiscountRate,
};
