using Acme.Billing;

namespace Acme.Billing.Tests;

public class CartTests
{
	[Fact]
	public void AddItem_merges_same_sku()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "PEN", 1.5m, 2);
		CartOps.AddItem(cart, "PEN", 1.5m, 3);
		Assert.Single(cart.Items);
		Assert.Equal(5, CartOps.ItemCount(cart));
	}

	[Fact]
	public void AddItem_rejects_invalid_qty()
	{
		Assert.Throws<ArgumentException>(() => CartOps.AddItem(CartOps.Create(), "PEN", 1m, 0));
	}

	[Fact]
	public void Subtotal_single_item()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "MUG", 7.25m, 2);
		Assert.Equal(14.5m, Totals.Subtotal(cart));
	}

	[Fact]
	public void Subtotal_several_items()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "MUG", 7.25m, 2);
		CartOps.AddItem(cart, "PEN", 1.5m, 4);
		CartOps.AddItem(cart, "BAG", 12m, 1);
		Assert.Equal(32.5m, Totals.Subtotal(cart));
	}

	[Fact]
	public void Bulk_discount_from_10_units()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "PEN", 2m, 10);
		Assert.Equal(1m, Totals.Discount(cart));
	}

	[Fact]
	public void Total_adds_regional_vat()
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "MUG", 10m);
		CartOps.AddItem(cart, "BAG", 20m);
		Assert.Equal(36.9m, Totals.Total(cart, "PT"));
		Assert.Equal(30m, Totals.Total(cart, "XX"));
	}
}
