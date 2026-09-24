namespace Acme.Billing;

/// <summary>
/// Pricing rules: bulk quantity, seasonal campaigns, loyalty points, shipping and customer tiers.
/// Only CustomerDiscountRate and BulkDiscountRate feed the cart discount.
/// </summary>
public static class PricingRules
{
	// ---------------------------------------------------------------------------
	// Bulk quantity
	// ---------------------------------------------------------------------------

	private static readonly (int MinUnits, decimal Rate)[] BulkTiers =
	[
		(10, 0.05m),
		(25, 0.08m),
		(50, 0.12m),
	];

	public static int TotalUnits(IEnumerable<CartItem> items) => items.Sum(i => i.Qty);

	public static decimal BulkDiscountRate(IEnumerable<CartItem> items)
	{
		var units = TotalUnits(items);
		foreach (var (min, rate) in BulkTiers)
		{
			if (units >= min) return rate;
		}
		return 0m;
	}

	// ---------------------------------------------------------------------------
	// Seasonal campaigns (storefront banners — not applied by Totals)
	// ---------------------------------------------------------------------------

	public static readonly (string Id, string SkuPrefix, decimal Rate, string From, string To)[] Campaigns =
	[
		("spring", "GARDEN-", 0.15m, "2026-03-20", "2026-04-30"),
		("summer", "BEACH-", 0.20m, "2026-06-21", "2026-08-31"),
		("back-to-school", "BOOK-", 0.10m, "2026-09-01", "2026-09-30"),
		("black-friday", "", 0.25m, "2026-11-27", "2026-11-30"),
	];

	// ---------------------------------------------------------------------------
	// Loyalty points (decoy 0.1 — not a cart discount)
	// ---------------------------------------------------------------------------

	public const decimal LoyaltyRate = 0.1m;

	public static int LoyaltyPoints(decimal netAmount, string tier = "standard")
	{
		var multiplier = tier.ToLowerInvariant() switch
		{
			"silver" => 1.25m,
			"gold" => 1.5m,
			"vip" => 2m,
			_ => 1m,
		};
		return (int)Math.Floor(netAmount * LoyaltyRate * multiplier);
	}

	// ---------------------------------------------------------------------------
	// Shipping
	// ---------------------------------------------------------------------------

	public static decimal ShippingCost(decimal netAmount, string? region)
	{
		var (flat, freeFrom) = (region ?? "").ToUpperInvariant() switch
		{
			"PT" => (3.5m, 40m),
			"ES" => (4.9m, 50m),
			"DE" => (6.9m, 60m),
			"FR" => (5.9m, 60m),
			_ => (12m, decimal.MaxValue),
		};
		return netAmount >= freeFrom ? 0m : flat;
	}

	// ---------------------------------------------------------------------------
	// Validation / describe helpers (padding — keep VIP rate near the bottom)
	// ---------------------------------------------------------------------------

	public static bool IsKnownTier(string tier) =>
		tier.Equals("standard", StringComparison.OrdinalIgnoreCase)
		|| tier.Equals("silver", StringComparison.OrdinalIgnoreCase)
		|| tier.Equals("gold", StringComparison.OrdinalIgnoreCase)
		|| tier.Equals("vip", StringComparison.OrdinalIgnoreCase);

	public static string NormalizeTier(string? tier)
	{
		var t = (tier ?? "standard").ToLowerInvariant();
		return IsKnownTier(t) ? t : "standard";
	}

	public static string DescribeBulk() =>
		string.Join("; ", BulkTiers.Select(t => $"{t.MinUnits}+ units: {t.Rate:P0}"));

	public static string DescribeCampaigns() =>
		string.Join(", ", Campaigns.Select(c => c.Id));

	public static decimal CampaignRateFor(string sku, DateOnly? today = null)
	{
		var day = today ?? DateOnly.FromDateTime(DateTime.UtcNow);
		decimal best = 0;
		foreach (var c in Campaigns)
		{
			var from = DateOnly.Parse(c.From);
			var to = DateOnly.Parse(c.To);
			if (day >= from && day <= to && sku.StartsWith(c.SkuPrefix, StringComparison.Ordinal)
			    && c.Rate > best)
			{
				best = c.Rate;
			}
		}
		return best;
	}

	public static string CampaignBanner(DateOnly? today = null)
	{
		var day = today ?? DateOnly.FromDateTime(DateTime.UtcNow);
		decimal best = 0;
		string? id = null;
		foreach (var c in Campaigns)
		{
			var from = DateOnly.Parse(c.From);
			var to = DateOnly.Parse(c.To);
			if (day >= from && day <= to && c.Rate > best)
			{
				best = c.Rate;
				id = c.Id;
			}
		}
		return id is null ? "" : $"{id}: up to {(int)(best * 100)}% off";
	}

	public static decimal PointsToEuro(int points) => Money.Round2(points / 100m);

	public static decimal? FreeShippingGap(decimal netAmount, string? region)
	{
		var freeFrom = (region ?? "").ToUpperInvariant() switch
		{
			"PT" => 40m,
			"ES" => 50m,
			"DE" => 60m,
			"FR" => 60m,
			_ => (decimal?)null,
		};
		if (freeFrom is null) return null;
		return Money.Round2(Math.Max(0, freeFrom.Value - netAmount));
	}

	// ---------------------------------------------------------------------------
	// Customer tiers
	// ---------------------------------------------------------------------------

	/// <summary>
	/// Discount rate per customer tier. See docs/pricing.md ("Customer tiers").
	/// </summary>
	private const decimal SilverRate = 0.03m;
	private const decimal GoldRate = 0.5m;
	private const decimal VipRate = 0.1m;

	private static readonly Dictionary<string, decimal> TierDiscounts = new(StringComparer.OrdinalIgnoreCase)
	{
		["standard"] = 0m,
		["silver"] = SilverRate,
		["gold"] = GoldRate,
		["vip"] = VipRate,
	};

	public static decimal CustomerDiscountRate(Cart cart)
	{
		if (cart.Blocked) return 0m;
		return TierDiscounts.TryGetValue(cart.Tier, out var r) ? r : 0m;
	}
}
