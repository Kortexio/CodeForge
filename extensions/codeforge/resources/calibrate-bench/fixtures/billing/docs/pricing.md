# Pricing rules

## Order of operations

1. Subtotal = sum of `Price * Qty` for every item.
2. Discount = subtotal × the best single rate (customer tier or bulk — they do not stack).
3. Net = subtotal − discount.
4. Tax = net × regional VAT (PT 23%, ES 21%, DE 19%, FR 20%; unknown = 0).
5. Total = net + tax.

Amounts are rounded to 2 decimals (`MidpointRounding.AwayFromZero`).

## Customer tiers

| Tier     | Discount |
|----------|----------|
| standard | 0%       |
| silver   | 3%       |
| gold     | 5%       |
| vip      | 10%      |

## Bulk quantity

10+ units: 5% · 25+ units: 8% · 50+ units: 12%.

## Coupons

`Coupons.ApplyCoupon(Cart cart, string code, DateOnly? today = null)` returns the coupon
discount amount (does not mutate the cart). Coupons live in `config/coupons.json`.

- Codes are case-insensitive.
- `percent`: `subtotal × value / 100`.
- `fixed`: `value`, never more than the subtotal.
- Valid through the `expires` day inclusive; after that throw `ExpiredCouponException`.
- Unknown codes throw `InvalidCouponException`.
- Result rounded to 2 decimals.
