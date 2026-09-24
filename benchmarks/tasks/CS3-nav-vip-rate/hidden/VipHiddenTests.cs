using Acme.Billing;

namespace Acme.Billing.Tests.BenchHidden;

public class VipHiddenTests
{
	[Fact]
	public void Vip_customers_get_15_percent()
	{
		Assert.Equal(0.15m, PricingRules.CustomerDiscountRate(CartOps.Create("vip")));
		var cart = CartOps.Create("vip");
		CartOps.AddItem(cart, "X", 100m);
		Assert.Equal(15m, Totals.Discount(cart));
	}

	[Fact]
	public void Other_tiers_unchanged()
	{
		Assert.Equal(0m, PricingRules.CustomerDiscountRate(CartOps.Create("standard")));
		Assert.Equal(0.03m, PricingRules.CustomerDiscountRate(CartOps.Create("silver")));
		Assert.Equal(0.05m, PricingRules.CustomerDiscountRate(CartOps.Create("gold")));
		Assert.Equal(0m, PricingRules.CustomerDiscountRate(CartOps.Create("vip", blocked: true)));
	}

	[Fact]
	public void Loyalty_decoy_untouched()
	{
		Assert.Equal(0.1m, PricingRules.LoyaltyRate);
		Assert.Equal(20, PricingRules.LoyaltyPoints(100m, "vip"));
	}

	[Fact]
	public void Best_rate_wins_vip_over_bulk()
	{
		var cart = CartOps.Create("vip");
		CartOps.AddItem(cart, "X", 1m, 60);
		Assert.Equal(9m, Totals.Discount(cart));
	}
}
