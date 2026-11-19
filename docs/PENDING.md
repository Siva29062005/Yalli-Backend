# Pending features and fixes

Single list of open work for Yalli (backend + `frontend/`). Tick an item (`[x]`) and add the date when it is
done; add new items as they are found. Sources: the "known limitations" sections of the phase docs, the
frontend readiness note, and a code review on 2026-11-19.

**Last updated:** 2026-11-19
**State:** backend phases 2–7 are implemented. The storefront, sign-in, account pages and all admin screens use the real
API. The admin screens are verified against a fake backend and against the real app on an isolated database (`npm run
serve:browser`); the dev Docker stack still needs its image rebuilt (see README).

Priorities: **P0** blocks launch · **P1** should be done before or soon after launch · **P2** later / at scale.

---

## P0 — Launch blockers

### Admin screens (wired to the real API on 2026-11-19)
All nine screens now load from and act through the admin API with `admin-session` (staff login, MFA, shared step-up prompt
with automatic retry) and have no demo data. They are verified with `frontend/scripts/test-admin-screens.mjs`
(fake HTTP boundary: pages, step-up, payloads, 375px layout) and the backend e2e suites, but NOT yet against a live backend.

- [x] Products list (`/admin/products`) and the demo fallback (`api-client.ts`, `catalog-data.ts`) removed (2026-11-19).
- [x] Product editor (`/admin/products/new`, `/admin/products/[id]`): create, edit, variants, images, publish (2026-11-19).
- [x] Inventory and stock adjustment, with per-SKU history (2026-11-19).
- [x] Orders and fulfilment: detail, packing, shipping with tracking, tracking updates, cancel (2026-11-19).
- [x] Refunds and returns: request (Idempotency-Key), approve/reject (no self-approval), return decisions (2026-11-19).
- [x] Coupons: list, create, edit, pause (all-items and category scope) (2026-11-19).
- [x] Shipping methods (2026-11-19).
- [x] Users and roles: search, give/remove role, suspend/restore (new `GET /admin/users`) (2026-11-19).
- [x] Analytics: KPIs, revenue-by-day chart with table view, top products, statuses, GST (2026-11-19).
- [x] Every admin screen run against the REAL backend (real Nest app, PostgreSQL roles, auth, MFA, rules; isolated
      database, Razorpay simulator) with `npm run serve:browser` + `frontend/scripts/test-admin-real.mjs` (2026-11-19):
      totals from the server, stock ledger, fulfilment state machine, image upload, duplicate coupon refused, overdraw
      refused, staff role refused without MFA, refund four-eyes, suspend/restore; no 5xx, no page errors, 375px fits.
- [ ] Not covered by that run: the MFA step-up prompt against the real backend (a fresh login is already "recent"; the
      prompt is covered by the fake-backend script), and the dev Docker stack (its `yalli-app` image predates
      `GET /admin/users` and `/admin/brands`: rebuild it, then check the screens there once).

Follow-ups found while wiring (P1 unless noted):
- [ ] Product list shows counts only; add price range, stock and category columns (needs the list API to return them).
- [ ] Product editor: no brand create/delete UI (API exists), no image reordering or per-variant images, no stock field
      (stock is Inventory's job).
- [ ] Coupons: creating a product-scoped coupon needs a product picker (existing ones can be edited; the list is kept).
- [x] Permission-aware navigation (2026-11-19): `/me` now returns the caller's own permissions (from the database).
      The sidebar, a per-screen gate ("your role cannot open this area"), the landing page (first screen the role can
      use) and key buttons (publish, delete, adjust stock, fulfil, approve, ...) follow them. Hiding is cosmetic; the API
      still enforces every permission. If a backend does not send permissions (an old image), nothing is hidden.
      Verified on the real backend with a CUSTOMER_SUPPORT account: only its four screens, view-only editors, no 403 calls.
- [ ] Review moderation screen (`/admin/reviews` API exists, no UI) and a customer support view (order lookup by customer).
- [ ] Warehouses and low-stock thresholds are read-only (no API to change them).
- [ ] Order detail shows returns as a count only; link it to the Refunds & returns tab.

### Storefront gaps
- [x] Pages added 2026-11-19: `/help`, `/shipping`, `/returns`, `/privacy`, `/terms`, `/contact`, all linked from the footer
      (original plain-language drafts that match how the shop behaves; see `docs/policies/store-policies-and-tax.md`).
- [x] The fake newsletter form is removed (the footer now points to the email-offers switch in My profile).
      A guest newsletter with double opt-in is P2.
- [x] App-wide `error.tsx`, `global-error.tsx`, `not-found.tsx` and `admin/error.tsx` added (no stacks or messages shown).
- [ ] **Owner input, blocks launch:** fill the `NEXT_PUBLIC_BUSINESS_*` settings (legal name, registered address, GSTIN,
      support email/phone/hours, grievance officer name/designation/email/phone). Pages omit missing lines in production,
      so an unconfigured site would show no way to reach you. Also set `SELLER_LEGAL_NAME` and `SELLER_GSTIN` for invoices.
      The Consumer Protection (E-Commerce) Rules 2020 require a named grievance officer.
- [ ] **Have a lawyer review** the privacy, terms and returns pages before launch, and confirm: the 7-day window (the pages
      say 7; the backend value is `RETURN_WINDOW_DAYS`, keep them equal), the "no replacements or exchanges" wording, the
      third-party list in the privacy page (Razorpay, SES, MSG91, AWS, Turnstile, HIBP) and the DPDP dates (core duties
      13 May 2027; check Gazette G.S.R. 843(E)).
- [ ] `next.config.ts` allows images from `images.unsplash.com` and plain-HTTP `localhost`. Replace both with the
      production image host (S3/CDN) before launch.
- [ ] No self-service "delete my account" screen (the pages tell customers to contact you).

### Live integrations not yet verified
- [ ] Razorpay end to end with TEST keys: payment, webhook and refund. Needs `RAZORPAY_KEY_ID`,
      `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Amazon SES email and MSG91 SMS. MSG91 needs a DLT-approved OTP template.
- [ ] Turnstile captcha and HIBP. So far they have only been tested through fakes.

### Deployment and operations (needs AWS access)
- [ ] AWS deployment, the S3 image storage adapter (production refuses local disk storage), WAF and alarms.
- [ ] Production CORS, CSP, cookie and HTTPS settings for the real domain, including the frontend-to-backend proxy.
- [ ] The user runs `./scripts/verify-docker.sh` (Phase 6 and 7 checks) and `./scripts/dr-drill.sh`.
- CI and Dependabot: not wanted (owner decision 2026-11-19). Run `npm run check` and the frontend checks by hand.

### Business and tax decisions (adopted 2026-11-19; accountant to confirm)
Researched and recorded in `docs/policies/store-policies-and-tax.md` (rules, sources, what the shop does today).
- [x] Policies adopted as they stand in the code: 7-day returns from delivery, 30-minute payment window, full automatic
      refund when a paid, unshipped order is cancelled, one coupon per cart, GST-inclusive prices (18% default), refunds to
      the original payment method only, four-eyes approval for human refunds.
- [ ] **GST on delivery fees:** decision made (the fee is part of one composite supply, GST-inclusive, apportioned to the
      order's lines by value and taxed at each line's rate), NOT implemented. Delivery stays free until it is built;
      the Shipping screen warns when a fee is entered. Build: `priceCart` allocation, order storage, invoice, analytics.
- [ ] **Credit notes:** decision made (one per processed refund, referencing the invoice, proportional CGST/SGST/IGST;
      report by 30 November after the financial year of the original supply), NOT implemented. Finance issues them by hand
      until then; the GST summary does not net refunds.

---

## P1 — Fix soon

### Issues in the current (uncommitted) changes
- [ ] The product listing's rating aggregate (`catalog-query.service.ts`) reads the reviews module's
      `product_reviews` table directly, which breaks the rule that modules talk only through each other's
      services. Move it behind the reviews module (or a read model), or record it as a deliberate exception.
- [ ] `src/cli/create-test-admin.ts` is blocked only when `NODE_ENV=production`, and it prints the MFA secret to
      the console. Require an explicit opt-in (e.g. `NODE_ENV=development` plus an `ALLOW_TEST_ADMIN=1` flag),
      add an npm script and document it.
- [x] `docs/frontend/production-readiness.md` brought up to date (2026-11-19).
- [x] `Figma Design.zip` ignored (2026-11-19).
- [ ] `docs/frontend/canva-prompts.md` hard-codes 8 navigation categories, but categories now come from the API.

### Frontend quality gate
- [ ] `npm run check` does not cover `frontend/`. Add its lint, type-check, build and unit specs
      (`category-utils`, `http`, `analytics-utils` specs currently run by hand with `npx vitest run frontend/src`).
- [ ] Find a way to run the Playwright scripts (the storefront ones also need `node scripts/test-catalog.mjs --mock-api <port>`
      and a frontend started with `API_INTERNAL_URL` pointing at it) (`frontend/scripts/test-*.mjs`) without hand-set
      `PLAYWRIGHT_MODULE` / `CHROMIUM_PATH`.
- [ ] Accessibility audit (contrast, keyboard, screen reader), cross-browser mobile tests, and performance and
      dependency audits.

### Security
- [ ] Captcha after repeated login failures.
- [ ] Re-encode uploaded images (e.g. with `sharp`) to strip EXIF/GPS data before staff upload phone photos.
- [ ] Token refresh is de-duplicated within one tab only (`token-session.ts`). Two tabs refreshing at the same
      moment look like token reuse and end the session. Coordinate across tabs (BroadcastChannel or a lock), or
      add a short grace window on the server.
- [ ] During a Redis outage, the per-request session check is not mapped to a 503. Map it, and monitor Redis.
- [ ] Check that the PIN code matches the state on addresses.

### Commerce and operations
- [ ] Courier integration (e.g. Shiprocket) behind `ShippingService.applyEventInTx`. Staff enter tracking by hand today.
- [ ] Refund reconciliation: a dashboard or CSV export to match against Razorpay settlement reports.
- [ ] OpenCart data import: convert the real store's export, and add product images (not imported today).
- [ ] Sitemap and SEO metadata (the contact page now exists).
- [ ] Run the reservation sweeper as its own worker in production (today it runs in-process every 30 s).

---

## P2 — Later / at scale
- [ ] Split shipments, partial cancellation, and splitting one order's reservation across warehouses.
- [ ] Catalogue read caching or denormalised price columns; OpenSearch for search (current search has no stemming
      and no Indian-language support).
- [ ] Filter the admin inventory list in the database instead of in memory.
- [ ] Reviews: helpfulness votes, photos and seller replies.
- [ ] Geo / impossible-travel anomaly detection on sign-in.
- [ ] A slow hash for recovery codes; harden phone OTP storage.
- [ ] The notification consumer can send an email twice if it crashes after sending but before commit.
- [ ] An approval step for the catalogue importer.
- [ ] Evaluate Nest's first-party `@nestjs/outbox`, `idempotency`, `webhooks`, `authentication` and `authorization`.
