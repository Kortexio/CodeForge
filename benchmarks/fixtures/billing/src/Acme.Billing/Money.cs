namespace Acme.Billing;

public static class Money
{
	public static decimal Round2(decimal n) =>
		Math.Round(n, 2, MidpointRounding.AwayFromZero);
}
