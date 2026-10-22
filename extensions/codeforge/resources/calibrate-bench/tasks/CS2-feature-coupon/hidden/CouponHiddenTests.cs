using Acme.Billing;

namespace Acme.Billing.Tests.BenchHidden;

public class CouponHiddenTests
{
	private static readonly DateOnly Now = new(2026, 1, 15);

	private static Cart CartOf(decimal amount)
	{
		var cart = CartOps.Create();
		CartOps.AddItem(cart, "X", amount);
		return cart;
	}

	[Fact]
	public void Percent_coupon()
	{
		Assert.Equal(5m, Coupons.ApplyCoupon(CartOf(50m), "WELCOME10", Now));
		Assert.Equal(3.33m, Coupons.ApplyCoupon(CartOf(33.33m), "WELCOME10", Now));
	}

	[Fact]
	public void Codes_are_case_insensitive()
	{
		Assert.Equal(5m, Coupons.ApplyCoupon(CartOf(50m), "welcome10", Now));
	}

	[Fact]
	public void Fixed_coupon_capped_at_subtotal()
	{
		Assert.Equal(5m, Coupons.ApplyCoupon(CartOf(50m), "FIVEOFF", Now));
		Assert.Equal(3m, Coupons.ApplyCoupon(CartOf(3m), "FIVEOFF", Now));
	}

	[Fact]
	public void Expired_and_unknown_throw()
	{
		Assert.Throws<ExpiredCouponException>(() => Coupons.ApplyCoupon(CartOf(50m), "OLD20", Now));
		Assert.Throws<InvalidCouponException>(() => Coupons.ApplyCoupon(CartOf(50m), "NOPE", Now));
	}

	[Fact]
	public void Valid_on_expiry_day()
	{
		Assert.Equal(20m, Coupons.ApplyCoupon(CartOf(100m), "OLD20", new DateOnly(2020, 1, 1)));
	}

	[Fact]
	public void Does_not_mutate_cart()
	{
		var cart = CartOf(50m);
		var before = cart.Items.Count;
		_ = Coupons.ApplyCoupon(cart, "WELCOME10", Now);
		Assert.Equal(before, cart.Items.Count);
	}
}
