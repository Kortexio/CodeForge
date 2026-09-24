using Acme.Router;

namespace Acme.Router.Tests.BenchHidden;

public class C02HiddenTests
{
	private static RouteId Id(string v) => RouteId.Create(v);

	[Fact]
	public void Normalizes_method_and_path()
	{
		var r = new Route(Id("users"), "get", "/users/", 2);
		Assert.Equal("GET", r.Method);
		Assert.Equal("/users", r.Path);
		Assert.Equal(2, r.Priority);
		Assert.Equal(Id("users"), r.Id);
		Assert.Equal("/", new Route(Id("root"), "GET", "/").Path);
		Assert.Equal(0, new Route(Id("root"), "GET", "/").Priority);
	}

	[Fact]
	public void Rejects_unknown_method()
	{
		var ex = Assert.Throws<ArgumentException>(() => new Route(Id("x"), "PATCH", "/x"));
		Assert.Contains("METHOD_NOT_SUPPORTED", ex.Message);
	}

	[Fact]
	public void Rejects_relative_path()
	{
		var ex = Assert.Throws<ArgumentException>(() => new Route(Id("x"), "GET", "x"));
		Assert.Contains("PATH_INVALID", ex.Message);
	}

	[Fact]
	public void Rejects_negative_priority()
	{
		Assert.Throws<ArgumentOutOfRangeException>(() => new Route(Id("x"), "GET", "/x", -1));
	}
}
