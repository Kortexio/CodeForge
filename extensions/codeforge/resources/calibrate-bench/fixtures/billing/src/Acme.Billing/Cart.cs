namespace Acme.Billing;

public sealed class Cart
{
	public string Tier { get; init; } = "standard";
	public bool Blocked { get; init; }
	public List<CartItem> Items { get; } = [];
}

public sealed class CartItem
{
	public required string Sku { get; init; }
	public required decimal Price { get; init; }
	public int Qty { get; set; } = 1;
}

public static class CartOps
{
	public static Cart Create(string tier = "standard", bool blocked = false) =>
		new() { Tier = tier, Blocked = blocked };

	public static Cart AddItem(Cart cart, string sku, decimal price, int qty = 1)
	{
		if (string.IsNullOrWhiteSpace(sku)) throw new ArgumentException("INVALID_ITEM");
		if (qty <= 0) throw new ArgumentException("INVALID_QTY");
		if (price < 0) throw new ArgumentException("INVALID_PRICE");
		var existing = cart.Items.FirstOrDefault(i => i.Sku == sku);
		if (existing is not null)
		{
			existing.Qty += qty;
		}
		else
		{
			cart.Items.Add(new CartItem { Sku = sku, Price = price, Qty = qty });
		}
		return cart;
	}

	public static int ItemCount(Cart cart) => cart.Items.Sum(i => i.Qty);
}
