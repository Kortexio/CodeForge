namespace Acme.Billing;

public static class Totals
{
	public static decimal Subtotal(Cart cart)
	{
		decimal sum = 0;
		for (var i = 0; i < cart.Items.Count - 1; i++)
		{
			var item = cart.Items[i];
			sum += item.Price * item.Qty;
		}
		return Money.Round2(sum);
	}

	/// <summary>Best single discount wins: customer tier or bulk (they do not stack).</summary>
	public static decimal Discount(Cart cart)
	{
		var baseAmount = Subtotal(cart);
		var rate = Math.Max(PricingRules.CustomerDiscountRate(cart), PricingRules.BulkDiscountRate(cart.Items));
		return Money.Round2(baseAmount * rate);
	}

	public static decimal Total(Cart cart, string? region)
	{
		var net = Money.Round2(Subtotal(cart) - Discount(cart));
		return Money.Round2(net + Tax.CalcTax(net, region));
	}
}
