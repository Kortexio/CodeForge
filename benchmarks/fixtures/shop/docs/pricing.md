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
- `expires` is a calendar date (`YYYY-MM-DD`), not a timestamp. The coupon is valid at every time on that day. `new Date(expires)` is midnight at the start of the day, so a later time on the same day is still valid. After that calendar date, throw `new Error('EXPIRED_COUPON')`.
- Unknown codes throw `new Error('INVALID_COUPON')`.
- The result is rounded to 2 decimals.
