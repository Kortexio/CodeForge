using Acme.Router;

namespace Acme.Router.Tests.BenchHidden;

public class C03HiddenTests
{
	private static Route R(string id, string method, string path, int priority = 0) =>
		new(RouteId.Create(id), method, path, priority);

	[Fact]
	public void Matches_literal_routes()
	{
		var t = new RouteTable();
		t.Add(R("users", "GET", "/users"));
		t.Add(R("users-post", "POST", "/users"));
		Assert.Equal(2, t.Count);
		Assert.Equal("users", t.Match("get", "/Users/")!.Id.Value);
		Assert.Equal("users-post", t.Match("POST", "/users")!.Id.Value);
		Assert.Null(t.Match("DELETE", "/users"));
		Assert.Null(t.Match("GET", "/orders"));
	}

	[Fact]
	public void Rejects_duplicate_method_and_path()
	{
		var t = new RouteTable();
		t.Add(R("a", "GET", "/a"));
		var ex = Assert.Throws<InvalidOperationException>(() => t.Add(R("b", "get", "/A/")));
		Assert.Contains("DUPLICATE_ROUTE", ex.Message);
	}

	[Fact]
	public void Rejects_duplicate_id()
	{
		var t = new RouteTable();
		t.Add(R("a", "GET", "/a"));
		var ex = Assert.Throws<InvalidOperationException>(() => t.Add(R("A", "POST", "/b")));
		Assert.Contains("DUPLICATE_ID", ex.Message);
	}
}
