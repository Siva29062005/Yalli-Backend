# Phase 4 — Core commerce (implemented)

Customers & addresses, catalogue, inventory, pricing, coupons and cart. Checkout, orders and payments are Phase 5.
This document describes what the code does; anything not listed is not implemented.

## Business invariants and where they are enforced

| Invariant | Application | Database | Tests |
|---|---|---|---|
| Stock can never go negative; reservations never exceed stock | single conditional `UPDATE … WHERE on_hand - reserved >= qty` | `inventory_reserved_chk`, `inventory_on_hand_chk` | 25 buyers / 5 units ⇒ exactly 5 win |
| A reservation is all-or-nothing per order | one transaction, sorted lock order | — | multi-line rollback, opposite-order baskets (no deadlock) |
| An expired reservation can never be committed | commit checks `expires_at > now()` atomically | — | expiry + sweeper test |
| Every stock change is traceable | ledger row in the same transaction | `inventory_movements` append-only (trigger + revoked grants) | ledger + tamper tests |
| Customers never set prices | strict schemas, cart stores no prices, re-priced on every view | — | client-price rejection, live re-pricing |
| Money is exact | integer paise, largest-remainder allocation, half-up GST | price CHECKs, `sale < price` | 5,000-cart property test |
| A coupon is never over-redeemed | conditional increment + per-customer advisory lock, idempotent per order | `coupons_redemptions_chk`, unique (coupon, order) | 12 customers / limit 3 ⇒ 3; 6 parallel same customer ⇒ 1 |
| One default address per customer; Indian address format | transactional default switch | partial unique index, PIN/country CHECKs | address tests |
| SKUs are unique case-insensitively, forever | — | unique `lower(sku)` | duplicate SKU test |
| Customers only touch their own data (BOLA) | every query scoped by `principal.userId`; foreign id ⇒ 404 | FK to `users` | address/cart isolation tests |
| Price changes need explicit authority | `pricing.update` required on top of `products.update`; before/after audited | — | custom-role test |

## Endpoints (`/api/v1`)

Public: `GET /catalog/products` (q, category incl. sub-categories, brand, minPrice, maxPrice, inStock, special, sort ∈
relevance/newest/name_asc/name_desc/price_asc/price_desc, page, pageSize ≤ 60), `GET /catalog/products/:slug`,
`GET /catalog/categories` (tree + product counts), `GET /catalog/brands`, `GET /media/:key` (images).

Guest or signed-in (`@OptionalAuth`; guests send `X-Cart-Token`): `GET|DELETE /cart`, `POST /cart/items`,
`PATCH|DELETE /cart/items/:variantId`, `POST|DELETE /cart/coupon`. Signed-in: `POST /cart/merge`.

Customer: `PATCH /me`, `POST /me/export`, `DELETE /me`, `GET|POST /me/addresses`, `GET|PATCH|DELETE /me/addresses/:id`,
`PUT /me/addresses/:id/default`.

Admin (permission + MFA step-up + audit): products/variants/brands/categories/images under `/admin/…`
(`products.*`, prices `pricing.update`), `/admin/inventory`, `/admin/inventory/adjustments`, `/admin/inventory/movements`,
`/admin/warehouses` (`inventory.*`), `/admin/coupons` (`coupons.manage`).

## Interfaces Phase 5 (checkout) builds on

- `InventoryService.reserve(ref, lines, ttl)` / `commit(ref)` / `release(ref, reason)` / `expireDue()` / `reconcile()`.
- `priceCart(lines, couponRule)` — the only pricing function; checkout snapshots its output into the order.
- `CouponService.redeemInTx(tx, …)` — call inside the order transaction.
- `CartService.view()` already reports unpurchasable lines; checkout must refuse a cart with any `issue`.

## Assumptions to confirm

1. Prices are GST-inclusive (as on the current site) with a per-product rate, default **18 %**; the tax breakdown (CGST/SGST vs IGST) needs the ship-to state and is computed at checkout.
2. **Shipping is ₹0** until Phase 6 adds shipping methods and rates.
3. One coupon per cart (no stacking).
4. Max 10 units per line, 50 lines per cart, 20 saved addresses, 20 images per product.

## Known limitations / open risks

1. **Uploaded images are validated by signature but not re-encoded**: EXIF metadata (e.g. GPS) is kept and an image with
   trailing data is stored as-is. Served with the recorded type, `nosniff` and `default-src 'none'`, so it cannot execute,
   but re-encoding (e.g. `sharp`) should be added before staff upload phone photos.
2. **Local disk image storage** is development-only (production boot is refused); the S3 adapter comes with AWS access.
3. A reservation is taken from one warehouse; splitting an order across warehouses is not implemented (single warehouse today).
4. The reservation sweeper runs in-process every 30 s; in production it should run as a dedicated worker (it is already safe on many instances).
5. Catalogue reads are not cached yet; the listing query aggregates variants per request (fine for thousands of products;
   add caching / denormalised price columns before large catalogues).
6. Search uses PostgreSQL `simple` text search + trigram (no stemming, no Indian-language analysis); OpenSearch can replace it behind `CatalogQueryService`.
7. The admin inventory list filters in memory (fine at current scale).
8. Guest cart tokens are bearer secrets: the storefront must keep them out of URLs and logs.
9. No OpenCart data import yet (needs an export from the current store).
10. Account deletion anonymises the customer; order retention rules arrive with orders in Phase 5.
