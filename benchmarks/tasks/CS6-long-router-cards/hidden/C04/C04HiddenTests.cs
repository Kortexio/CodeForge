using Acme.Router;

namespace Acme.Router.Tests.BenchHidden;

public class C04HiddenTests
{
	[Fact]
	public void Detects_parameters()
	{
		Assert.True(RoutePattern.IsParametric("/users/{id}"));
		Assert.False(RoutePattern.IsParametric("/users/me"));
	}

	[Fact]
	public void Extracts_values()
	{
		Assert.True(RoutePattern.TryMatch("/users/{id}/orders/{orderId}", "/users/42/orders/7", out var v));
		Assert.Equal("42", v["id"]);
		Assert.Equal("7", v["orderId"]);
		Assert.Equal("7", v["ORDERID"]);
	}

	[Fact]
	public void Literal_segments_are_case_insensitive()
	{
		Assert.True(RoutePattern.TryMatch("/Users/{id}", "/users/1", out var v));
		Assert.Equal("1", v["id"]);
	}

	[Theory]
	[InlineData("/users/{id}", "/users")]
	[InlineData("/users/{id}", "/users/1/orders")]
	[InlineData("/users/{id}", "/orders/1")]
	public void No_match(string pattern, string path)
	{
		Assert.False(RoutePattern.TryMatch(pattern, path, out var v));
		Assert.Empty(v);
	}
}
