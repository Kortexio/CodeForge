# Pricing rules

## Order of operations

1. Subtotal = sum of `price * qty` for every item.
2. Discount = subtotal × the best single rate (customer tier or bulk quantity — they do not stack).
3. Net = subtotal − discount.
4. Tax = net × regional VAT rate (PT 23%, ES 21%, DE 19%, FR 20%; unknown regions pay no VAT).
5. Total = net + tax.

All amounts are rounded to 2 decimals.

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

`applyCoupon(cart, code, now = new Date())` returns the coupon discount amount for a cart
(it does not mutate the cart). Coupons are defined in `config/coupons.json`.

- Codes are case-insensitive (`welcome10` is the same as `WELCOME10`).
- `percent` coupons: `subtotal × value / 100`.
- `fixed` coupons: `value`, but never more than the subtotal.
- A coupon is valid up to and including its `expires` date. After that, throw `new Error('EXPIRED_COUPON')`.
- Unknown codes throw `new Error('INVALID_COUPON')`.
- The result is rounded to 2 decimals.
