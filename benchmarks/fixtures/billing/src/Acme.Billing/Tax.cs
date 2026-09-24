namespace Acme.Billing;

public static class Tax
{
	private static readonly Dictionary<string, decimal> Rates = new(StringComparer.OrdinalIgnoreCase)
	{
		["PT"] = 0.23m,
		["ES"] = 0.21m,
		["DE"] = 0.19m,
		["FR"] = 0.20m,
	};

	public static decimal Rate(string? region) =>
		Rates.TryGetValue(region ?? "", out var r) ? r : 0m;

	public static decimal CalcTax(decimal amount, string? region) =>
		Money.Round2(amount * Rate(region));
}
