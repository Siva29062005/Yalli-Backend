# Pending features and fixes

Single list of open work for Yalli (backend + `frontend/`). Tick an item (`[x]`) and add the date when it is
done; add new items as they are found. Sources: the "known limitations" sections of the phase docs, the
frontend readiness note, and a code review on 2026-11-19.

**Last updated:** 2026-11-19
**State:** backend phases 2–7 are implemented. The storefront, sign-in, account pages and all admin screens use the real
API. The admin screens have been tested against a fake backend only, not yet a live one.

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
- [ ] Permission-aware navigation: `/me` returns roles but not permissions, so the sidebar shows every screen and a
      role without access sees the API's 403 message. Return permissions (or a nav list) and hide what is not allowed.
- [ ] Admin landing page is `/admin/categories`; switch to the overview once navigation is permission-aware.
- [ ] Review moderation screen (`/admin/reviews` API exists, no UI) and a customer support view (order lookup by customer).
- [ ] Warehouses and low-stock thresholds are read-only (no API to change them).
- [ ] Order detail shows returns as a count only; link it to the Refunds & returns tab.

### Storefront gaps
- [ ] Footer links `/help`, `/shipping` and `/privacy` lead to 404s. Add these pages plus terms, returns/refund
      policy and contact. Razorpay's website review normally asks for these pages before it activates live payments.
- [ ] The newsletter form in `Footer.tsx` shows "subscribed" without sending anything, and the backend has no
      endpoint for it. Either build one (consent plus double opt-in) or remove the form.
- [ ] There are no app-wide `error.tsx`, `not-found.tsx` or loading boundaries (only `products/[slug]/not-found`
      and `catalog/loading` exist).
- [ ] `next.config.ts` allows images from `images.unsplash.com` and plain-HTTP `localhost`. Replace both with the
      production image host (S3/CDN) before launch.

### Live integrations not yet verified
- [ ] Razorpay end to end with TEST keys: payment, webhook and refund. Needs `RAZORPAY_KEY_ID`,
      `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Amazon SES email and MSG91 SMS. MSG91 needs a DLT-approved OTP template.
- [ ] Turnstile captcha and HIBP. So far they have only been tested through fakes.

### Deployment and operations (needs AWS access)
- [ ] AWS deployment, the S3 image storage adapter (production refuses local disk storage), WAF and alarms.
- [ ] Production CORS, CSP, cookie and HTTPS settings for the real domain, including the frontend-to-backend proxy.
- [ ] The user runs `./scripts/verify-docker.sh` (Phase 6 and 7 checks) and `./scripts/dr-drill.sh`.
- [ ] CI: `.github/workflows/ci.yml` and Dependabot were removed in commit `043ee10`, so nothing runs
      automatically. Restore them once the GitHub remote exists.

### Business and tax decisions (user or accountant)
- [ ] GST on the delivery fee. Today only items are taxed; decide before enabling paid shipping.
- [ ] Credit notes for refunds. The GST summary is not reduced by refunds.
- [ ] Confirm these assumptions: prices are GST-inclusive at 18% by default, one coupon per cart, a 7-day return
      window, a 30-minute payment window, and a full automatic refund when a paid order is cancelled.

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
- [ ] `Figma Design.zip` (about 32 MB) sits untracked in the repo root. Add it to `.gitignore` or move it out
      before the first push.
- [ ] `docs/frontend/canva-prompts.md` hard-codes 8 navigation categories, but categories now come from the API.

### Frontend quality gate
- [ ] `npm run check` does not cover `frontend/`. Add its lint, type-check, build and unit specs
      (`category-utils`, `http`, `analytics-utils` specs currently run by hand with `npx vitest run frontend/src`).
- [ ] Find a way to run the Playwright scripts (`frontend/scripts/test-*.mjs`) without hand-set
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
- [ ] Sitemap, SEO metadata and a contact page.
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
