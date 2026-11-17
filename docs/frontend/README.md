# Yalli — Frontend Developer Guide

This document is for frontend teams building on the Yalli backend. It lists every
customer- and staff-facing feature you can build, the endpoints that power it, and the
cross-cutting API conventions you must handle. The backend is a NestJS REST API; there is
no GraphQL or mobile-specific surface — everything below is plain JSON over `HTTPS`.

> **Base URL:** `/api/v1/...` (versioned). Health probes are unversioned at `/health/live`,
> `/health/ready` — never call them from UI code.

---

## 1. API conventions you must implement

| Concern | Rule |
|---|---|
| **Response envelope** | Every response is `{ success, message, data, meta, timestamp, requestId }`. List endpoints also carry `meta: { page, pageSize, total, totalPages }`. |
| **Errors** | `success: false` with a stable `code`: `BAD_REQUEST`, `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `STEP_UP_REQUIRED`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_SUSPENDED`, `MFA_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `TOO_MANY_REQUESTS`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`. Stacks/SQL are never leaked. |
| **Auth** | `Authorization: Bearer <accessToken>` (Ed25519-signed JWT, ~15 min TTL). Refresh via `POST /auth/refresh` (opaque rotating token, cookie or body depending on your platform). |
| **Money** | Integer paise (minor units) everywhere: `49000` = ₹490.00. Never do float math on prices. |
| **Dates** | ISO-8601 UTC timestamps. Reports use India calendar days (`Asia/Kolkata`). |
| **Pagination** | `?page=1&pageSize=20` (max page size **60**, max page 10 000). Unknown query params are rejected — do not invent parameters. |
| **Rate limits** | `429 TOO_MANY_REQUESTS` includes a `Retry-After` header (seconds). Surface it as "slow down / try again in Ns" instead of retrying. |
| **Idempotency** | Checkout (`POST /checkout/orders`) and refunds require an `Idempotency-Key` header — on retry/network errors, replay the **same key** to avoid duplicate orders. |
| **Guest carts** | First cart write returns `data.cartToken` (or `cartToken` field). Store it and send it back as header `x-cart-token` on all cart calls. After login, call `POST /cart/merge` to fold the guest cart into the account. |
| **Step-up MFA** | Sensitive admin actions return `403 STEP_UP_REQUIRED` (30 min window); re-authenticate with `POST /auth/mfa/verify` then retry. |

---

## 2. Storefront features (public / customer)

### Catalogue & discovery
Build: home page, category pages, brand pages, search, product detail, compare, special-offers page.

| Feature | Endpoint | Notes |
|---|---|---|
| Product listing with **full-text search** | `GET /catalog/products?q=...` | Filters: `category`, `brand`, `minPrice`/`maxPrice` (paise), `inStock`, `special`; sorts: `relevance, newest, name_asc, name_desc, price_asc, price_desc` |
| Sale price with struck-through original | same response | `amountMinor` = payable, `compareAtMinor` = original (sale) |
| Product detail (sanitised HTML) | `GET /catalog/products/:slug` | `descriptionHtml` is allow-list sanitised — still render safely |
| Category tree | `GET /catalog/categories` | parent/child, use for breadcrumbs & nav |
| Brands | `GET /catalog/brands` | |
| Product comparison (2–4) | `GET /catalog/compare?slugs=a,b,c` | side-by-side attributes |
| Product images | `GET /media/:key` | version-neutral; prefix with `MEDIA_BASE_URL` (env-provided) |

### Cart (guest + signed-in)
Build: add/remove/update quantity, coupon box, guest checkout, cart badge, cart persistence across sign-in.

| Feature | Endpoint |
|---|---|
| Read cart | `GET /cart` |
| Add item (price is **server-computed**; client-sent prices are rejected) | `POST /cart/items` `{ variantId, quantity }` |
| Change quantity | `PATCH /cart/items/:variantId` |
| Remove item / clear cart | `DELETE /cart/items/:variantId` / `DELETE /cart` |
| Apply / remove coupon | `POST /cart/coupon` `{ code }` / `DELETE /cart/coupon` |
| Merge guest cart after login | `POST /cart/merge` (with `x-cart-token`) |

### Account, auth & security
Build: register/login forms, email-verification & password-reset flows, phone OTP login,
2FA (TOTP) enrollment screen, active-sessions manager, address book, profile.

| Feature | Endpoint |
|---|---|
| Register (email + phone + password, consent) | `POST /auth/register` → `202`; verify link arrives by email (dev: printed to app logs) |
| Email verification / resend | `POST /auth/verify-email` `{ token }` / `POST /auth/resend-verification` |
| Login (blocking: unverified → `EMAIL_NOT_VERIFIED`, locked, suspended states) | `POST /auth/login` |
| Logout / logout-all | `POST /auth/logout` / `POST /auth/logout-all` |
| Forgot / reset password | `POST /auth/forgot-password` → `POST /auth/reset-password` `{ token, newPassword }` |
| Change password | `POST /auth/change-password` |
| Refresh access token | `POST /auth/refresh` |
| Phone OTP login | `POST /auth/phone/send-otp` → `POST /auth/phone/verify` |
| MFA: enroll → confirm → verify → disable | `POST /auth/mfa/enroll` → `/confirm` → `/verify` → `/disable` |
| MFA recovery codes (show once, regenerate) | response of `/enroll` · `POST /auth/mfa/recovery-codes/regenerate` |
| Profile | `GET /me` |
| Active sessions list / revoke one | `GET /auth/sessions` / `DELETE /auth/sessions/:id` |

### Orders, payments, returns
Build: checkout page, payment sheet (Razorpay), order list/detail, tracking timeline,
cancel, GST invoice download, return-request flow.

| Feature | Endpoint |
|---|---|
| Checkout **quote** (what you'll be charged, incl. shipping) | `POST /checkout/quote` |
| Place order | `POST /checkout/orders` + `Idempotency-Key` header → stock reserved |
| Start payment | `POST /orders/:id/payments` (Razorpay order created; UI opens the payment sheet) |
| Confirm payment | `POST /orders/:id/payments/confirm` |
| Poll payment status | `GET /orders/:id/payment-status` |
| My orders / order detail | `GET /orders` / `GET /orders/:id` |
| Live tracking (carrier events) | `GET /orders/:id/tracking` |
| Cancel unpaid/paid order | `POST /orders/:id/cancel` |
| GST tax invoice | `GET /orders/:id/invoice` |
| Request a return | `POST /orders/:id/returns` `{ orderId, orderItemId, quantity, reason, details }` |
| My returns | `GET /returns` |

Addresses: `GET/POST /me/addresses`, `GET/PATCH/DELETE /me/addresses/:id`,
`PUT /me/addresses/:id/default`.

### Social proof
| Feature | Endpoint |
|---|---|
| Product reviews (list, summary with rating distribution) | `GET /catalog/products/:slug/reviews` / `.../reviews/summary` |
| Write / edit / delete my review (1–5 stars, purchase-gated) | `POST /catalog/products/:slug/reviews` · `PATCH /me/reviews/:id` · `DELETE /me/reviews/:id` |
| My reviews | `GET /me/reviews` |
| **Wishlist** (by slug, add/remove, list) | `GET /me/wishlist` · `PUT /me/wishlist/:slug` · `DELETE /me/wishlist/:slug` |

---

## 3. Admin / staff portal features (role-gated)

All of these require `Bearer` + the matching permission; customers get `403 FORBIDDEN`
automatically. Roles: `SUPER_ADMIN`, `FINANCE_MANAGER`, `INVENTORY_MANAGER`, etc. —
inspect the live catalog with `GET /admin/roles` and `GET /admin/permissions`.

| Feature area | Endpoints |
|---|---|
| **Catalog management** — create/edit/delete products, brands, categories, variants; publish/unpublish/archive; image upload (multipart) | `POST/PATCH/DELETE /admin/products*`, `/admin/brands*`, `/admin/categories/:id`, `/admin/variants*`, `POST /admin/products/:id/images` |
| **Catalog import** — bulk load a spreadsheet/CSV export of products | CLI/import service (`npm run import:catalog`); expose behind an admin UI job if needed |
| **Inventory** — warehouses, stock per variant, audit-logged adjustments, movement history | `GET /admin/warehouses` · `GET /admin/inventory` · `POST /admin/inventory/adjustments` · `GET /admin/inventory/movements` |
| **Coupons** — create/expire percentage or fixed-amount codes with product/category scopes | `GET/POST /admin/coupons` · `GET/PATCH /admin/coupons/:id` |
| **Shipping** — configure methods (fee, delivery ETA range, eligible states) used by checkout quotes | `GET/POST /admin/shipping-methods` · `PATCH /admin/shipping-methods/:id` |
| **Order operations** — search orders, view payments, update carrier tracking, mark fulfilled, cancel with reason | `GET /admin/orders` · `GET /admin/orders/:id` · `GET /admin/orders/:id/payments` · `POST /admin/orders/:id/tracking` · `POST /admin/orders/:id/fulfilment` · `POST /admin/orders/:id/cancel` |
| **Returns & refunds (four-eyes)** — decide return requests, record receipt, create refunds, approve/reject | `GET /admin/returns` · `POST /admin/returns/:id/decision` · `POST /admin/returns/:id/received` · `GET/POST /admin/refunds` · `POST /admin/refunds/:id/approve` · `POST /admin/refunds/:id/reject` |
| **User administration** — grant/revoke roles, suspend/activate accounts | `POST/DELETE /admin/users/:userId/roles` · `PATCH /admin/users/:userId/status` |
| **Review moderation** — list reviews, hide/approve decision | `GET /admin/reviews` · `POST /admin/reviews/:id/decision` |
| **Analytics dashboards** (read-only reporting role, India calendar days) | `GET /admin/analytics/overview` (paid orders, gross/net/refunds, AOV, status mix) · `sales-by-day` · `top-products` · `gst-summary` (CGST/SGST/IGST split that reconciles to totals) — all accept `?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 31 days) |
| **Step-up re-auth for sensitive ops** | `POST /auth/mfa/step-up` |

---

## 4. Server-side flows — build UI around the signals, not the plumbing

- **Payment webhooks** (`POST /webhooks/razorpay`) are signed server-to-server. The frontend
  never calls them; after the Razorpay sheet closes, poll `GET /orders/:id/payment-status`
  (the order reaches `PAID` only once the server verifies the webhook).
- **Events** (order.created / order.cancelled / notifications) flow outbox → RabbitMQ; a
  backend consumer records deliveries. If you later build push/email notification pages,
  the backend emits these events — no extra endpoint needed for them.
- **Unpaid-order expiry**: an order holds its stock for `PAYMENT_WINDOW_MINUTES` (default 30)
  then auto-cancels; show the payment deadline from `paymentExpiresAt` in the order view (checkout response).

## 5. What is NOT in the backend yet (plan your UI accordingly)

- Courier live-tracking integration (tracking data is stored & admin-editable; no carrier API)
- Contact / newsletter / static info pages (data model exists for consent & newsletter flag;
  no CMS)
- Sitemap & SEO endpoints
- Object-store (S3) image hosting — `MEDIA_BASE_URL` is currently the local dev store
- Credit notes (invoices exist; credit-note generation is a roadmap item)
- GST on delivery fees

## 6. Local development

```bash
npm install && ./scripts/setup-dev-env.sh && docker compose up -d
docker compose --profile tools run --build --rm migrate
docker compose --profile tools run --rm seed   # add BOOTSTRAP_ADMIN_* to .env for a first admin
npm run start:dev                              # API on :3000, Swagger at /docs (dev only)
```

CORS: set `CORS_ALLOWED_ORIGINS=http://localhost:5173` (exact origin, no wildcards) in `.env`.
`LOG_PRETTY=true` gives human-readable logs; in dev the console notification driver prints
verification links/OTPs to the app log — convenient for wiring auth flows without an inbox.

Reference screenshots of the intended storefront: `reference/` (repo root).
