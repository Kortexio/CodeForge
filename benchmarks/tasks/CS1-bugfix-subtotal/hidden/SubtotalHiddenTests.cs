using Acme.Billing;

namespace Acme.Billing.Tests.BenchHidden;

public class SubtotalHiddenTests
{
	[Fact]
	public void Subtotal_counts_every_item()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "A", 10m);
		CartOps.AddItem(cart, "B", 2.5m, 2);
		CartOps.AddItem(cart, "C", 1.25m, 4);
		Assert.Equal(20m, Totals.Subtotal(cart));
	}

	[Fact]
	public void Empty_cart_subtotal_is_zero()
	{
		Assert.Equal(0m, Totals.Subtotal(CartOps.Create()));
	}

	[Fact]
	public void Single_item_still_works()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "A", 3m, 3);
		Assert.Equal(9m, Totals.Subtotal(cart));
	}

	[Fact]
	public void Totals_agree_with_tax()
	{
		var cart = CartOps.Create("silver");
		CartOps.AddItem(cart, "A", 30m);
		CartOps.AddItem(cart, "B", 70m);
		Assert.Equal(119.31m, Totals.Total(cart, "PT"));
	}
}
