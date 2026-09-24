using Acme.Router;

namespace Acme.Router.Tests.BenchHidden;

public class C01HiddenTests
{
	[Fact]
	public void Trims_value()
	{
		Assert.Equal("home", RouteId.Create("  home ").Value);
		Assert.Equal("home", RouteId.Create("home").ToString());
	}

	[Theory]
	[InlineData(null)]
	[InlineData("")]
	[InlineData("   ")]
	public void Rejects_empty(string? value)
	{
		var ex = Assert.Throws<ArgumentException>(() => RouteId.Create(value!));
		Assert.Contains("ROUTE_ID_EMPTY", ex.Message);
	}

	[Fact]
	public void Rejects_too_long()
	{
		var ex = Assert.Throws<ArgumentException>(() => RouteId.Create(new string('a', 33)));
		Assert.Contains("ROUTE_ID_TOO_LONG", ex.Message);
		Assert.Equal(32, RouteId.Create(new string('a', 32) + "  ").Value.Length);
	}

	[Fact]
	public void Equality_is_case_insensitive()
	{
		var a = RouteId.Create("Home");
		var b = RouteId.Create("home");
		Assert.True(a == b);
		Assert.True(a.Equals(b));
		Assert.Equal(a.GetHashCode(), b.GetHashCode());
		Assert.False(a == RouteId.Create("about"));
	}
}
