---
name: .NET value object
description: Value object with guards, factory and case-insensitive equality (C#)
triggers: [value object, valueobject, objeto de valor, guard clause, entidade, entity, domain model, modelo de domínio]
---
Factory + guards + value equality. Error messages are the codes the card asks for.

```csharp
namespace Acme.App.Domain;

public sealed class Sku : IEquatable<Sku>
{
	public string Value { get; }

	private Sku(string value) => Value = value;

	public static Sku Create(string? value)
	{
		var v = (value ?? "").Trim();
		if (v.Length == 0) throw new ArgumentException("SKU_EMPTY");
		if (v.Length > 20) throw new ArgumentException("SKU_TOO_LONG");
		return new Sku(v.ToUpperInvariant());
	}

	public bool Equals(Sku? other) =>
		other is not null && string.Equals(Value, other.Value, StringComparison.OrdinalIgnoreCase);
	public override bool Equals(object? obj) => Equals(obj as Sku);
	public override int GetHashCode() => StringComparer.OrdinalIgnoreCase.GetHashCode(Value);
	public static bool operator ==(Sku? a, Sku? b) => a is null ? b is null : a.Equals(b);
	public static bool operator !=(Sku? a, Sku? b) => !(a == b);
	public override string ToString() => Value;
}
```

A `sealed record` is enough when equality is exact (no case rules): `public sealed record Money(decimal Amount, string Currency);`
