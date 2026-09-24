using Acme.Router;

namespace Acme.Router.Tests.BenchHidden;

public class C05HiddenTests
{
	private static Route R(string id, string method, string path, int priority = 0) =>
		new(RouteId.Create(id), method, path, priority);

	[Fact]
	public void Literal_beats_parametric()
	{
		var t = new RouteTable();
		t.Add(R("user", "GET", "/users/{id}", 9));
		t.Add(R("me", "GET", "/users/me"));
		var m = t.Resolve("GET", "/users/me")!;
		Assert.Equal("me", m.Route.Id.Value);
		Assert.Empty(m.Values);
		var p = t.Resolve("get", "/users/5")!;
		Assert.Equal("user", p.Route.Id.Value);
		Assert.Equal("5", p.Values["id"]);
	}

	[Fact]
	public void Higher_priority_wins_then_insertion_order()
	{
		var t = new RouteTable();
		t.Add(R("a", "GET", "/items/{id}", 1));
		t.Add(R("b", "GET", "/items/{slug}", 5));
		t.Add(R("c", "GET", "/items/{key}", 5));
		Assert.Equal("b", t.Resolve("GET", "/items/x")!.Route.Id.Value);
	}

	[Fact]
	public void Method_must_match()
	{
		var t = new RouteTable();
		t.Add(R("a", "POST", "/items/{id}"));
		Assert.Null(t.Resolve("GET", "/items/1"));
		Assert.Null(t.Resolve("POST", "/other/1"));
	}

	[Fact]
	public void Match_ignores_parametric_routes()
	{
		var t = new RouteTable();
		t.Add(R("a", "GET", "/items/{id}"));
		Assert.Null(t.Match("GET", "/items/1"));
	}
}
