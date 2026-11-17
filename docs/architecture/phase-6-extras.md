# Phase 6 — Shipping, reviews, wishlist, notifications, analytics, catalogue import (implemented)

Everything here is verified by automated tests against a real PostgreSQL, **except** the three external services
(Amazon SES, MSG91, and your OpenCart data). Those are tested against fakes and documented under "Not yet verified".

New migrations: `20261120000000_shipping`, `20261121000000_reviews_wishlists`, `20261122000000_report_indexes`.

## 6a. Shipping

**Delivery fee.** Admin-configured `shipping_methods` (code, flat fee in paise, optional free-above threshold, ETA,
optional list of states served). The fee is decided in one place (`shipping-rules.ts`) from the items total **after
discount**, then the cart is priced once more with it (`priceCart` stays the only pricing function).

| Situation | Behaviour |
|---|---|
| No active method configured | shipping is ₹0 and the order records no method (the pre-Phase-6 behaviour is preserved) |
| Methods exist, none serves the address | quote says `UNAVAILABLE`, checkout is refused (`SHIPPING_UNAVAILABLE`) |
| Exactly one option | applied automatically |
| More than one option | the buyer must name one (`SHIPPING_METHOD_REQUIRED`); a quote defaults to the cheapest for preview |
| Unknown / not-offered code | `SHIPPING_METHOD_INVALID`, nothing is created |

The order stores a **snapshot** (`shipping_method_code`, `shipping_method_name`, `shipping_minor`); editing a method later
never changes an existing order. The client can only send a method **code** — never a fee. `expectedTotalMinor` still
protects against a changed total. Cancelling a paid order refunds the whole amount, delivery included.

**Shipments and tracking.** Marking an order SHIPPED (admin fulfilment endpoint) creates the shipment (one per order) and
its first event in the same transaction. `(carrier, tracking_number)` is unique. Tracking updates move **forward only**
(IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED, with DELIVERY_FAILED / RETURNED_TO_SELLER); a repeat is an idempotent no-op;
a future timestamp is refused. `DELIVERED` also completes the order and sends the customer notification.
`shipment_events` is append-only (trigger + revoked UPDATE/DELETE).

| Endpoint | Who |
|---|---|
| `GET/POST /admin/shipping-methods`, `PATCH /admin/shipping-methods/:id` | `shipments.manage`, step-up |
| `POST /admin/orders/:id/tracking`, `GET /admin/orders/:id/tracking` | `shipments.manage` / `orders.read`, step-up |
| `GET /orders/:id/tracking` | the customer who owns the order (a foreign id is a 404) |
| `POST /checkout/quote` and `POST /checkout/orders` accept `shippingMethodCode` | customer |

## 6b. Reviews, wishlist, compare

**Reviews.** Only a customer who **received** the product (a DELIVERED order containing it) can review it — paid or merely
browsing is refused (`REVIEW_REQUIRES_PURCHASE`). One review per product (DB unique). Text is plain: all markup is
stripped on write and a body that is too short once stripped is refused. New and **edited** reviews are PENDING until a
moderator (`reviews.moderate`) approves; only APPROVED reviews are public, shown as "Asha K." with no ids. A review can be
decided once (conditional update, so two moderators cannot both decide). The DB refuses an APPROVED/REJECTED review with no
moderator on record and a rating outside 1–5. Public summary (count, average to one decimal from integer counts,
distribution) counts approved reviews only.

**Wishlist.** `PUT/DELETE /me/wishlist/:slug`, `GET /me/wishlist` (cards with live price and stock). Saving is idempotent,
private to the customer, capped at 200, and only for published products. Removing returns the same 200 for an unknown
slug, an unpublished product and an item that was never saved, so it cannot be used to discover unpublished products.

**Compare.** `GET /catalog/compare?slugs=a,b[,c,d]` (public, 2–4 distinct published products).

**Privacy.** Account deletion erases the customer's reviews and wishlist in the same transaction; the data export includes
both.

## 6c. Notification channels (Amazon SES, MSG91)

`NOTIFICATIONS_DRIVER=ses_msg91` sends email through **SES v2** and OTP SMS through **MSG91**; `console` remains for local
development and is still refused in production. All email content is rendered by pure, tested templates
(`notification-templates.ts`): every dynamic value is HTML-escaped, token links are URL-encoded, subjects never contain a
token or control characters, and money is formatted from integer paise.

- **No AWS key in the application's configuration.** SES uses the default AWS credential chain (an IAM role in production).
- The MSG91 auth key goes in a **header** (never the URL); requests time out; error messages never contain the key.
- **Failure semantics.** Account-security emails are best-effort: a failure is logged and never thrown, so a delivery problem
  cannot reveal whether an account exists. Order messages and OTPs **throw**, so the order consumer is redelivered with
  backoff and the OTP request reports the failure. Logs hold only the type, a masked recipient and the error text.
- Required when `ses_msg91`: `SES_FROM_ADDRESS` (a verified SES identity), `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`
  (a DLT-approved flow template with a single variable named `otp`). `AWS_REGION` defaults to `ap-south-1`.

## 6d. Admin analytics (`analytics.read`, step-up)

`GET /admin/analytics/overview | sales-by-day | top-products | gst-summary` with `from`/`to` (`YYYY-MM-DD`).

- Days are **India calendar days**, inclusive at both ends; a missing range means the last 30 days; the range is capped at
  366 days; bad dates / inverted or oversized ranges are a 400.
- An order **counts when it was paid in the period**; gross = sum of totals, refunded = PROCESSED refunds in the period,
  net = gross − refunded; the average order value is rounded half-up with integer maths.
- All SQL is parameterised; sort keys map to fixed fragments. New partial indexes keep the reports index-driven.
- The GST summary splits CGST/SGST/IGST per rate from the amounts recorded on each order line.

## 6e. Catalogue import

`npm run build && node dist/cli/import-catalog.js --file catalog.json` (see the command's usage text).

- The file is **source-neutral JSON** (`version: 1`): categories (with parents), products, variants. Money is integer paise.
  It is validated completely first — shape, unknown fields, unknown categories, duplicate SKUs/slugs, category cycles — and a
  bad file writes **nothing**; every problem is reported in one pass.
- **Dry run by default.** `--apply --as <staff-email>` writes; the named user must be ACTIVE with `products.create` and
  `pricing.update`, and the audit record and stock receipts are attributed to them.
- Everything new is imported as **DRAFT** (`--publish` honours `PUBLISHED` from the file).
- **Idempotent.** Existing products (by slug) are left alone unless `--update-existing`; even then an import **never
  overwrites live stock or status** — opening stock is recorded only for brand-new variants, through the inventory ledger,
  inside the product's own transaction. Each product is its own transaction, so one failure is reported and skipped and a
  re-run resumes.
- Descriptions are sanitised; OpenCart stores them HTML-escaped, so set `options.decodeEntityEncodedDescriptions: true`.
- Images are **not** imported yet (no URL is fetched, which keeps SSRF out of scope); upload them with the admin endpoint, or
  after S3 exists.

### Converting an OpenCart store into the import file

The table mapping (OpenCart 3/4 names; **not verified against your database**):

| Import field | OpenCart source |
|---|---|
| category `name`, `parentKey` | `oc_category_description.name`, `oc_category.parent_id` |
| product `name`, `descriptionHtml` | `oc_product_description.name`, `.description` (escaped: set the decode option) |
| variant `sku`, `priceMinor`, `stock` | `oc_product.model` or `.sku`, `ROUND(oc_product.price * 100)`, `oc_product.quantity` |
| `salePriceMinor` | active row of `oc_product_special` (`ROUND(price * 100)`) |
| product → categories | `oc_product_to_category` |
| `brand` | `oc_manufacturer.name` |

Compute paise with `ROUND(price * 100)` on the DECIMAL column in SQL, never in floating point. Always dry-run first and
spot-check a few products against the live site.

## Operating notes

- **Every database session now runs in UTC** (`options: -c timezone=UTC`). The driver sends JavaScript dates without an
  offset, so a server or session in another zone (a developer laptop in IST) stored every timestamp shifted by the offset.
  This was found while testing analytics and is covered by a regression test.
- `docker compose` / `verify-docker.sh` now also check the Phase 6 database constraints.

## Not yet verified (honest list)

1. **Amazon SES and MSG91 against the real services.** The transports are tested against fakes (request shape, secret
   handling, failure semantics). Before launch: verify the sender identity and move SES out of the sandbox, register and
   approve the DLT template, send one real email and one real OTP.
2. **The OpenCart conversion.** The importer is tested; the mapping above has not been run against your actual database.
3. **Razorpay live** (carried from Phase 5).

## Known limitations and risks

- **GST on delivery fees is not computed** (items only). Delivery charges are generally taxable: confirm the treatment with
  your accountant before enabling paid shipping. The GST summary says so in its response.
- The GST summary is not reduced for refunds (no credit notes yet).
- One shipment per order (no split shipments); no live courier integration (tracking is entered by staff). A courier adapter
  (e.g. Shiprocket) fits behind the same `applyEventInTx` path.
- No review helpfulness votes, photos or seller replies. Reviews are moderated, not auto-screened.
- A saved item that was later unpublished still counts toward the 200 cap but is not listed.
- Analytics read orders/items/refunds directly (all inside the orders module). A read-only reporting DB role is a Phase 7
  hardening step.
- The importer attributes work to a named staff user but has no approval step; run it from a trusted host only.
