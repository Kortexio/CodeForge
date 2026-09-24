using System.Text.Json;

namespace Acme.Billing;

public sealed record Coupon(string Code, string Type, decimal Value, string Expires);

public static class Coupons
{
	public static IReadOnlyList<Coupon> Load(string file)
	{
		var json = File.ReadAllText(file);
		return JsonSerializer.Deserialize<List<Coupon>>(json, new JsonSerializerOptions
		{
			PropertyNameCaseInsensitive = false,
		}) ?? [];
	}

	/// <summary>
	/// Resolve config/coupons.json from the workspace root (walks up from cwd).
	/// </summary>
	public static string FindDefaultFile(string? startDir = null)
	{
		var dir = new DirectoryInfo(startDir ?? Directory.GetCurrentDirectory());
		while (dir is not null)
		{
			var candidate = Path.Combine(dir.FullName, "config", "coupons.json");
			if (File.Exists(candidate)) return candidate;
			dir = dir.Parent;
		}
		throw new FileNotFoundException("config/coupons.json not found");
	}

	public static decimal ApplyCoupon(Cart cart, string code, DateOnly? today = null)
	{
		var day = today ?? DateOnly.FromDateTime(DateTime.UtcNow);
		var coupon = Load(FindDefaultFile())
			.FirstOrDefault(c => string.Equals(c.Code, code, StringComparison.OrdinalIgnoreCase))
			?? throw new InvalidCouponException(code);
		if (day > DateOnly.Parse(coupon.Expires)) throw new ExpiredCouponException(code);
		var subtotal = Totals.Subtotal(cart);
		var amount = coupon.Type == "percent" ? subtotal * coupon.Value / 100m : Math.Min(coupon.Value, subtotal);
		return Money.Round2(amount);
	}
}

public sealed class InvalidCouponException(string code) : Exception($"INVALID_COUPON: {code}");

public sealed class ExpiredCouponException(string code) : Exception($"EXPIRED_COUPON: {code}");
