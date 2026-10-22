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
			PropertyNameCaseInsensitive = true,
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
}
