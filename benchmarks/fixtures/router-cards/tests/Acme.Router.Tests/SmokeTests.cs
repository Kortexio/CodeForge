using Acme.Router;

namespace Acme.Router.Tests;

public class SmokeTests
{
	[Fact]
	public void Assembly_loads()
	{
		Assert.Equal("Acme.Router", AssemblyMarker.Name);
	}
}
