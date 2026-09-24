---
name: xUnit tests
description: Minimal xUnit fact/theory and an architecture test by assembly references
triggers: [xunit, unit test, teste unitário, testes unitários, architecture test, teste de arquitetura, testes de arquitetura]
---
The xunit template already has `<Using Include="Xunit" />`; no `using Xunit;` needed.

```csharp
namespace Acme.App.Tests;

public class SkuTests
{
	[Fact]
	public void Normalizes_value() => Assert.Equal("AB-1", Sku.Create(" ab-1 ").Value);

	[Theory]
	[InlineData(null)]
	[InlineData("   ")]
	public void Rejects_empty(string? value)
	{
		var ex = Assert.Throws<ArgumentException>(() => Sku.Create(value));
		Assert.Contains("SKU_EMPTY", ex.Message);
	}
}
```

Architecture test (Domain must not reference Application). The test project references both projects:

```csharp
public class ArchitectureTests
{
	[Fact]
	public void Domain_does_not_reference_Application()
	{
		var refs = typeof(Acme.App.Domain.Sku).Assembly.GetReferencedAssemblies();
		Assert.DoesNotContain(refs, a => a.Name == "Acme.App.Application");
	}
}
```
