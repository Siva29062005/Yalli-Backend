# Pending features and fixes

Single list of open work for Yalli (backend + `frontend/`). Tick an item (`[x]`) and add the date when it is
done; add new items as they are found. Sources: the "known limitations" sections of the phase docs, the
frontend readiness note, a code review on 2026-11-19, a full frontend review the same day, and a whole-app bug and security review on
2026-11-27.

**Last updated:** 2026-11-27
**State:** backend phases 2–7 are implemented. The storefront, sign-in, account pages and all admin screens use the real
API. The admin screens are verified against a fake backend and against the real app on an isolated database (`npm run
serve:browser`); the dev Docker stack still needs its image rebuilt (see README).

The order of work (Phases 8-16) and the owner inputs are in `docs/ROADMAP.md`.

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
- [x] Product list shows category, current price (sale applied; range across live variants), sellable stock with Low/Out pills, and variant/image counts (2026-11-20). The API computes them with `effectivePrice` and `InventoryService.availability`.
- [ ] Product editor: no brand create/delete UI (API exists), no image reordering or per-variant images, no stock field
      (stock is Inventory's job).
- [ ] Coupons: creating a product-scoped coupon needs a product picker (existing ones can be edited; the list is kept).
- [x] Permission-aware navigation (2026-11-19): `/me` now returns the caller's own permissions (from the database).
      The sidebar, a per-screen gate ("your role cannot open this area"), the landing page (first screen the role can
      use) and key buttons (publish, delete, adjust stock, fulfil, approve, ...) follow them. Hiding is cosmetic; the API
      still enforces every permission. If a backend does not send permissions (an old image), nothing is hidden.
      Verified on the real backend with a CUSTOMER_SUPPORT account: only its four screens, view-only editors, no 403 calls.
- [x] Review moderation screen `/admin/reviews` (2026-11-20): waiting / published / rejected tabs, approve, reject with a reason; verified on the real backend that a pending review is not public and an approved one is. The reviewer is shown masked, as the API sends it.
- [ ] A customer support view (order lookup by customer).
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
- [x] (2026-11-27, Phase 10) Self-service data export and account deletion: `/account/data` (password, and the 2FA code when on; typed DELETE). Help and privacy pages updated.

### Frontend review 2026-11-19: launch blockers (each verified in the code)
- [x] (2026-11-27, Phase 9) **No captcha widget.** Register and forgot-password never send `captchaToken` (`lib/auth-api.ts`,
      `RegisterForm.tsx`), but production requires Turnstile (`env.ts`) and the backend rejects a missing token, so
      every sign-up and password reset would fail with `CAPTCHA_FAILED`. Add the Turnstile widget.
- [x] (2026-11-27, Phase 9) **Open redirect in `safeNext`** (`lib/customer-session.ts`): `next=%2F%09%2Fevil.com` (`/\t/evil.com`) passes the
      `//` and `/\` checks; the URL parser strips the tab, giving `//evil.com`. Login redirects a signed-in user on
      load, so no click is needed. Reject control characters or compare `new URL(next, origin).origin`.
- [x] (2026-11-27, Phase 9) **Two tabs end the session** (was P1). The access token is memory-only, so every new tab refreshes; two tabs
      loading together hit reuse detection (`auth.service.ts`, no grace window), revoke the session and email a
      theft warning. Coordinate refresh across tabs and/or add a short server grace window.
- [x] (2026-11-27, Phase 9) **Any 401 triggers refresh + retry** (`token-session.ts` `authed`): a wrong MFA code on step-up, 2FA disable or
      regenerate is sent twice, counting twice toward `MFA_FAIL_LIMIT` (lockout after ~5 typos) and rotating the
      refresh token each time. Give expired tokens a distinct error code and refresh only on it.
- [x] (2026-11-27, Phase 9) **Home page claims the shop does not honour** (`app/page.tsx`, `CartDrawer.tsx`): "up to 30% on bundles" (links
      to a non-existent `/catalog/tablet`), coupon `WELCOME100` (does not exist), "7-day replacement" (the returns page
      says no replacements), "Free shipping above ₹499" (fee comes from shipping methods), "WhatsApp support", and an
      invented testimonial. Remove or derive from real data.
- [x] (2026-11-27, Phase 9) **Server-side catalogue fetches share one rate-limit bucket** (`lib/catalog-api.ts`): the Next server calls the API
      from its own IP, so ~75 product pages a minute across all shoppers exhaust `catalog-list` (120/min) and everyone
      gets 429. Forward the client IP from a trusted proxy hop, or exempt the frontend server with a separate limit.
- [x] (2026-11-27, Phase 9) **Finance Manager cannot create or edit coupons**: the coupon form requires `GET /admin/categories`
      (`products.read`), which that role lacks. Make the category list optional or grant it to `coupons.manage`.

### Found while planning (2026-11-27)
- [x] (2026-11-27, Phase 10: `POST /contact` + form on /contact; emailed to `SUPPORT_INBOX_EMAIL` when set) Contact form: in the old site and the Phase 6 scope, never built. Needs a rate-limited, captcha-guarded
      `POST /contact` (stored + emailed to support) and the form on `/contact`.
- [x] (2026-11-27, Phase 10) Brand pages (`/brands`, `/brands/[slug]`, 404 for unknown) and a specials page (`/specials`), in the header, footer and sitemap.
- [ ] 301 redirects from the OpenCart URLs (`index.php?route=product/product&product_id=…`, category and information
      routes) to the new slugs, generated from the import mapping; without them search rankings are lost at cut-over.
- [ ] The frontend has no production container (`output: 'standalone'` is not set) and no hosting plan in
      `docs/ops/deployment-aws.md`.
- [x] (2026-11-27) Stale docs fixed: `production-readiness.md` describes the same-origin proxy, `deployment-aws.md`
      item 11 no longer mentions GitHub Actions, the README status and links are current.

### Security and bug review 2026-11-27: launch blockers (each verified in the code)
- [x] (2026-11-27, Phase 9) **A partial refund strands the order.** `PARTIALLY_REFUNDED` may only move to `REFUND_PENDING`
      (`order-state-machine.ts`) and `statusBeforeRefund` is not restored after a successful partial refund
      (`refund.service.ts`). A goodwill refund on a PAID order means it can never ship; after returning one item of a
      two-item order the second return is refused (needs DELIVERED). Restore the previous fulfilment state.
- [x] (2026-11-27, Phase 9) **Staff cancel is an unapproved full refund.** Admin cancel needs only `orders.update` and raises an auto-approved
      refund with `requestedById: null` (`order.service.ts`), bypassing four-eyes; an ORDER_MANAGER can ship off-system,
      leave the order PROCESSING and cancel it. Require `refunds.create` + a second approver for paid orders cancelled by
      staff (keep auto-approve for customer self-cancel).
- [x] (2026-11-27, Phase 9) **An authorized payment is never captured after a first failure.** A second look at an AUTHORIZED payment returns
      `duplicate`, so reconciliation never retries the capture, and an in-modal retry after a FAILED attempt is
      `ignored` (`payment.service.ts` `afterApply` / authorized branch); the expiry job then cancels a paying
      customer's order. Retry capture for AUTHORIZED payments in reconciliation, accept a new authorization on a FAILED
      payment of the same provider order, and enable auto-capture in the Razorpay dashboard regardless.
- [x] (2026-11-27, Phase 9) **`audit.record` inside the payment transaction** (`payment.service.ts` `onCaptured`: duplicate capture, amount
      mismatch, late capture) uses the shared client: pool starvation under a burst of late captures (Phase 7 rule), and
      the audit row commits even if the transaction rolls back. Add an `audit.recordInTx(tx, …)` and extend
      `pool-starvation.e2e-spec.ts` to the late-capture path.
- [x] (2026-11-27, Phase 9) **Invoice numbers are not a consecutive series per financial year.** `INV-` + `YL<calendar year>-<sequence>`
      (`checkout.service.ts`) has gaps (unpaid/cancelled orders, rollbacks) and uses the calendar year in the server time
      zone (GST Rule 46). Number invoices at payment from `document_counters` per Indian FY, like credit notes.
- [x] (2026-11-27, Phase 9) **Plain-text fields are stored HTML-encoded.** `stripTags` (`common/utils/sanitize-html.ts`) returns `&amp;`,
      `&lt;`, `&gt;`: "Kitchen & Dining" is stored and shown as `Kitchen &amp; Dining` (names, summaries, tags, alt text,
      review titles and bodies, imports), search for "&" stops matching, and the encoded text can exceed the column
      length after Zod checked it, giving a 500. Strip tags, decode entities, then re-check the length; repair stored rows.
- [x] (2026-11-27, Phase 9) **Staff sessions survive closing the tab.** The refresh and CSRF cookies get `expires` = the refresh expiry
      (`auth-cookies.service.ts`), though `admin-session.ts` says staff sessions are tab-scoped; the CSRF cookie is
      readable by script. On a shared PC, reopening the tab restores a staff session. Use session cookies (no
      `Expires`) for staff and for customers without "keep me signed in".
- [x] (2026-11-27, Phase 9) **Client IP through the Next proxy.** The rewrite passes the browser's `X-Forwarded-For` unchanged and adds no hop.
      With the default `TRUST_PROXY_HOPS=0` every shopper shares the Next server's IP (one attacker can trip the login
      and global limits for everyone); if Next is counted as a hop, `req.ip` is attacker-chosen and per-IP limits are
      bypassed. Decide the topology (Next appends the client IP, or the ALB/CloudFront hop count excludes Next), refuse
      `TRUST_PROXY_HOPS=0` in production, and document it in `deployment-aws.md`. Pairs with the SSR rate-limit item.

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
- [x] **GST on delivery fees** (built 2026-11-20): the fee is GST-inclusive, apportioned to the order's lines by value
      (exact, largest remainder) and taxed at each line's rate (composite supply, CGST Act s.8); stored per order line
      (`order_items.shipping_*`, CHECK-constrained), shown on the invoice as delivery lines per rate, included in the order's
      GST and in the analytics GST summary. Paid delivery can now be switched on (Admin > Shipping).
- [x] **Credit notes** (built 2026-11-20): one per processed refund of an invoiced order, issued from the
      `refund.processed` event (outside the money transaction, exactly once), numbered `CN/2627/000001` consecutively per
      Indian financial year (gapless counter), apportioned over what the invoice still has to credit (returns: the
      returned item first; other refunds: by value, delivery included), immutable (no write access for the app role +
      triggers). Customers see them under My orders; finance in Admin > Refunds and `GET /admin/credit-notes`; the GST
      summary nets them by issue date.
- [ ] Accountant to confirm the delivery-GST apportioning and the credit-note format before real orders, and whether
      goodwill refunds should carry a credit note (they do today; see the Finance Act 2026 change to s.34).
- [ ] Credit notes are not yet emailed as a document (the refund email goes out; the note is in My orders), and there is
      no credit-note number in GSTR-1 export form (no GST return export exists yet).

---

## P1 — Fix soon

### Issues in earlier changes
- [x] (2026-11-27) The listing's rating no longer reads `product_reviews`: the catalogue asks `ProductRatings`
      (`catalog/product-ratings.ts`), which the reviews module registers itself into (the reviews module depends on
      the catalogue, so the catalogue cannot import it). Same rounding as the product page (`summarise`); e2e-tested.
- [ ] Deliberate exception, revisit in Phase 10 (account deletion screen): `customers/account.service.ts` reads and
      deletes other modules' rows (cart, wishlist, reviews, MFA) for data export and erasure, so erasure stays one
      atomic transaction. If it is split, each module needs an `eraseForUserInTx(tx, userId)` method.
- [x] (2026-11-27) `create-test-admin` needs `NODE_ENV=development` AND `ALLOW_TEST_ADMIN=1` (`cli/test-admin-guard.ts`,
      unit-tested), writes the MFA secret to an owner-only temp file instead of the terminal, and has the npm script
      `create:test-admin` (README).
- [x] `docs/frontend/production-readiness.md` brought up to date (2026-11-19).
- [x] `Figma Design.zip` ignored (2026-11-19).
- [x] (2026-11-27) `docs/frontend/canva-prompts.md` treats the category names as sample content.

### Frontend review 2026-11-19: bugs
Checkout and cart
- [x] (2026-11-27, Phase 9) Payment `Idempotency-Key` is fixed per order (`pay-${orderId}` in `checkout/page.tsx`, `OrderConfirmation.tsx`), so
      every Pay click for 24 h replays the first response: an order cancelled meanwhile still opens Razorpay (then gets
      auto-refunded) and the FAILED→PENDING reset is skipped. Use a fresh key per click; reload the order on error.
- [x] (2026-11-27, Phase 9) A failed `/cart/merge` still clears the guest token (`cart-api.ts` `finally`): a network blip or 5xx on login loses
      the guest cart. Clear only on success or 400/404.
- [x] (2026-11-27, Phase 10) The cart "−" button sends `quantity - 1` even when the line is over stock, so it 409s forever; clamp to the
      available quantity (`CartLineControls.tsx`).
- [x] (2026-11-27, Phase 10) Checkout shows "Your cart is empty" when the cart failed to load (`cartStatus === 'error'`), with no retry.
- [x] (2026-11-27, Phase 10) Confirmation page: one failed poll silently stops polling and re-shows Pay; a stale `?payment=failed` keeps showing
      the error on a paid order after refresh.
- [x] (2026-11-27, Phase 10) Checkout: `CART_HAS_UNAVAILABLE_ITEMS` / shipping errors do not reload the quote; an unserved PIN code shows "Some
      items are unavailable"; any 503 says "Your order is saved" even before an order exists; no coupon remove button.
- [x] (2026-11-27, Phase 10) `<CartDrawer/>` is mounted per page, so the header cart icon does nothing on checkout/account/auth/orders and the
      drawer pops open later. Mount it once in the layout. Item counts differ between drawer (purchasable lines) and
      cart page (all lines).

Auth and account
- [x] (2026-11-27, Phase 9) A wrong 2FA code at login returns the user to the password step (`LoginForm.tsx` matches `/expired/` against "The
      code is incorrect or expired"). Distinguish wrong code from expired challenge by error code.
- [x] (2026-11-27, Phase 10) Order page: "Return this item" ignores `RETURN_WINDOW_DAYS` and units already returned, and the order is not reloaded
      after a return request (other buttons then fail with `ORDER_NOT_RETURNABLE`). Expose a return deadline from the API.
- [x] (2026-11-27, Phase 10) `AddressForm.tsx` reads `details[].path[0]`, but `path` is a dot-joined string: server field errors never reach the
      fields.
- [x] (2026-11-27, Phase 10) Account lists (wishlist, orders, returns, reviews) guess "Next" from `data.length === 20`; use `meta`. The wishlist
      provider stops early the same way (unpublished products are dropped after paging).
- [x] (2026-11-27, Phase 10) Invoice and credit-note windows open after an `await` (popup blockers). Open the window first.
- [x] (2026-11-27, Phase 10) `AuthProvider` signs the user out on any `/me` failure, including 5xx/network; logout is not seen by other tabs.
      `RegisterForm` drops `next`. (Reset/verify tokens are now removed from the URL and `/auth/*` sends no referrer:
      done 2026-11-27, Phase 9.)

Storefront
- [x] (2026-11-27, Phase 10) `/catalog/all-products` (first home tile and footer link) is an empty page: the "All" placeholder category is sent
      to the API as a slug. Unknown category slugs return 200 instead of 404.
- [x] (2026-11-27, Phase 10) Categories load only on the client (`CategoryProvider`): server HTML has heading "Category", no nav links. Category
      tile icons are keyed by old ids, so none show.
- [x] (2026-11-27, Phase 10) `formatIndianDate` has no `timeZone: 'Asia/Kolkata'`: hydration mismatch on review dates; analytics day labels shift
      for staff outside IST.
- [x] (2026-11-27, Phase 10) Price filter boxes do not follow back/forward navigation. Header search inputs and review star ratings lack
      accessible labels; mobile filter dialog has no Escape/focus trap. Categories refetch on every window focus.

Admin
- [x] (2026-11-27, Phase 11: `useClampedPage` in every paged admin list; history keyed by SKU) Lists stay on an
      empty page after the last row of a page is approved/deleted; inventory history keeps the page when switching SKU.
- [x] (2026-11-27, Phase 11) Inventory "Adjust" ignores the row's warehouse (always the default warehouse).
- [x] (2026-11-27, Phase 11: readable with `products.read`, form only with `products.update`, all calls via
      `withStepUp`) Categories screen is shown for `products.read` but needs `products.update`, and bypasses `withStepUp`.
- [x] (2026-11-27, Phase 11: the form sends only changed fields; the server ignores price fields equal to the current
      value for the permission check and the audit) Variant save always sends price fields.
- [x] (2026-11-27, Phase 11: `act` reports failure; `GET /admin/roles` marks `assignable` via `canAssignRole`) Order
      cancel form closes even when cancel fails; the role picker offers roles the caller cannot assign.

### Security and bug review 2026-11-27: fix soon
Money and orders
- [x] (2026-11-27, Phase 10: quote unpurchasable, place refused with ORDER_TOTAL_TOO_LOW) Orders totalling 0 (or under ₹1) can be placed (a FIXED coupon larger than the cart, free shipping) but
      `payments_amount_chk` (> 0) makes `POST /payments` a 500 while stock and the coupon stay held. Refuse at checkout
      (minimum payable ₹1) or cap fixed coupons.
- [ ] Releasing refund capacity locks REFUND/PAYMENT before ORDER (`refund.service.ts` reject/finishFailed → `recompute`):
      deadlock (40P01) against `requestInTx` / `applyProviderPayment` on the same order. Lock the order first.
- [ ] Refund webhook marks the event id processed before the work (`payment.service.ts`): a failure is acknowledged and
      only the reconcile poll catches it. On an amount mismatch the captured money is not auto-refunded and the payment is
      re-reconciled and re-audited every pass for 48 h.
- [x] (2026-11-27, Phase 9) `captureIfAuthorized` captures every authorized candidate (no break); a second capture is only audited.
- [ ] Creating a refund request is not audited (`commerce.controllers.ts`, `void ctx`).
- [x] (2026-11-27, Phase 9) Outbox: `run-once.ts` treated any P2002 from the work as "already processed" (now ON
      CONFLICT DO NOTHING); `order-events.consumer.ts` read through `this.prisma` inside the de-dupe transaction (now `tx`).
- [ ] Outbox relay: the comment says it stops at the first failure but the loop continues (event ordering).
- [ ] Staff can backdate delivery (`occurredAt` has only a future bound, `shipping.service.ts`), closing the customer's
      return window or putting delivery before shipping. Require `occurredAt >= shippedAt` and the previous event.
- [ ] Shipping methods (fee, free-above, active) are editable with `shipments.manage` (ORDER_MANAGER); deactivating all
      methods makes delivery free. Require `pricing.update` for fee fields.
- [ ] Restock always goes to the default warehouse although reservations can come from any (`inventory.service.ts`).

Identity and access
- [ ] Per-account MFA limit is a fixed 15-minute window of 10 that resets (`mfa.service.ts`): with a known password,
      about 960 guesses a day (~8% success a month), and the owner is not told. Add a daily cap / escalating lockout and
      email the owner on `MfaLocked` (correct password + wrong codes = password compromised).
- [x] (2026-11-27) Granting a non-customer role (`assignRole`) signs the person out everywhere.
- [ ] Enabling MFA (`confirm`) leaves older password-only sessions alive. Revoke the other sessions, as password change
      and role revoke already do.
- [ ] Turnstile verification does not check the `action` and `hostname` in Cloudflare's answer (`captcha.adapters.ts`):
      a token solved for one form or host is accepted on another. Pass the expected action and compare both.
- [ ] An authorization whose capture the provider keeps rejecting keeps its order from expiring until the provider voids
      it (days). Cap it: after the payment window plus a margin, cancel and let the authorization lapse.
- [ ] Two SUPER_ADMINs can suspend each other at once (`admin-access.service.ts` `setStatus`, no transaction or
      last-holder check), leaving none and no bootstrap path. Serialise it like `revokeRole`.
- [ ] Account deletion keeps `ip`, `userAgent` and `deviceLabel` in `user_sessions`, against the privacy page; scrub them.
- [ ] Re-auth for export/delete calls `verifyTotp` directly (skips the account MFA counter); a password change leaves an
      outstanding reset link usable; reset works on a suspended account; a pending login challenge survives a password
      reset; `@RequirePermissions()` with no names would mean "any signed-in user" (reject at boot).
- [ ] Admin and storefront share one refresh cookie (`yalli_rt`): signing in on one signs the other out.

Platform
- [ ] No `Cache-Control: no-store` on authenticated or token-bearing responses (login, refresh, MFA enrolment secret,
      recovery codes, `/me`, export). Add a global default before CloudFront sits in front of the API.
- [ ] Dev compose `app` and `seed` load the whole `.env`, so the container receives `DATABASE_MIGRATION_URL`, the
      migrator and the Postgres superuser passwords (against "the app never receives the migrator URL"). Pass an
      explicit variable list.
- [ ] Production env validation does not refuse: `FRONTEND_BASE_URL` left at `http://localhost:3001` (emailed reset
      links), a missing `REPORTING_DATABASE_URL` (reports fall back to the app role), non-TLS `redis://` / `amqp://`.
      RDS needs its CA bundle (`NODE_EXTRA_CA_CERTS`) because `rejectUnauthorized` is on; do not turn verification off.
- [ ] The immutability REVOKEs in migrations run only `IF EXISTS (yalli_app)`; on RDS a role created later, or a broad
      `GRANT … ON ALL TABLES`, gives back UPDATE/DELETE. Document the role SQL in `database-roles.md` or make it
      unconditional.
- [ ] Log redaction path `*.code` probably also hides `err.code` (P2002, ECONNREFUSED) in error logs; Prisma validation
      errors can carry argument values in the message (unverified).
- [ ] Dev: `.env.example` and `setup-dev-env.sh` still use `localhost:5173` for CORS and `FRONTEND_BASE_URL`; the
      frontend runs on 3001 and the CSRF Origin check needs the storefront origin listed (also in production; document it).
- [ ] `effect` (via the Prisma CLI, a dev dependency) has a ReDoS advisory (GHSA-7589-6fvf-x4pw); not reachable from
      requests. Add an npm override to ≥ 3.22.1 or wait for Prisma.

Catalogue and content
- [x] (2026-11-27, Phase 9) Cart merge can exceed 50 lines (count read once, `cart.service.ts`); checkout has no line cap.
- [ ] "Verified purchase" stays after the item was returned and refunded (`hasReceivedProduct`).
- [ ] `DELETE /admin/variants/:id` needs `products.update`, not `products.delete`; category counts include products
      with no active variant. (Fixed 2026-11-27, Phase 11: the import CLI now checks products.publish for `--publish`
      and inventory.adjust for stock, like the console.)

### Review of the Phase 10 commit (da146bc, 2026-11-27)
- [x] (2026-11-27) 18 confirmed findings fixed (contact form limits and length, brand counts, contact data in export and
      erasure, multi-tab sign-out, locked filters on /specials and /brands, cart load race, review paging, checkout
      refusals and quote race, price boxes, category banner). Record: `docs/security/phase-9-fixes.md`, last section.
- [ ] Measure the cost of the root layout's server category fetch on uncached renders (Phase 14 load check).

### Frontend review 2026-11-19: features with a backend but no UI
- [x] (2026-11-27, Phase 10) Customers: change password and sign out everywhere (`/account/security`), phone
      verification and resend verification email (profile), data export (`/account/data`), 2FA disable with a recovery
      code, order history, payment deadline and return deadline, product names and order numbers in the returns list.
- [x] (2026-11-27, Phase 10) Storefront: all reviews (paged) with the star breakdown, a "From" price for products whose
      variants cost different amounts, the brand filter scoped to the category (`GET /catalog/brands?category=`).
- [ ] Storefront: nested category filter (parent/child), and a "can I review?" check before writing a review.
- [x] (2026-11-27, Phase 11) Admin screen for contact-form messages (`/admin/messages`, mark handled, audited).
- [x] (2026-11-27, Phase 11) Admin: brand create/delete (`/admin/brands`), restore archived products, edit slug,
      image reorder/per-variant images (`PATCH /admin/images/:id`), returns status and order filters (linked from the
      order page), invoice and credit notes on admin order detail (`GET /admin/orders/:id/invoice|credit-notes`),
      tracking event time, take down an approved review (`POST /admin/reviews/:id/take-down`), product picker for
      product coupons (`GET /admin/products?ids=`).
- [x] (2026-11-27, Phase 11) Admin: credit-note register with GSTR-1 CSV, refund reconciliation export, refund retry,
      customer lookup, audit-log viewer, low-stock thresholds and warehouses, credit note attached to the refund email,
      catalogue import in the console. Record: `docs/architecture/phase-11-admin.md`.
- [ ] Refund reconciliation is our side only; match it against Razorpay's settlement report manually until the live
      account exists (Phase 13: use the settlement recon API).
- [ ] The emailed credit note is an HTML document; a PDF needs a server-side renderer (P2).
- [x] (2026-11-27) Review of the Phase 11 commit: 2 high (cancel retry after shipping; default-warehouse switch) and
      14 smaller findings fixed. Record: `docs/architecture/phase-11-admin.md`, last section.
- [ ] Privacy notice: say that sign-in and security events (with IP addresses) are kept in the audit log, and for how
      long (owner input; the audit viewer reads them).
- [ ] No Content-Security-Policy on the frontend; "stock held for 30 minutes" is hard-coded instead of
      `PAYMENT_WINDOW_MINUTES`.

### Frontend quality gate
- [x] (2026-11-27) `npm run check` ends with `check:frontend`: lint with no warnings allowed, build, type-check. The
      frontend unit specs already ran in `npm test` (root Vitest includes `frontend/src`).
- [x] (2026-11-27) `npm run test:browser` runs all 11 fake-backend scripts (mock API, test build in
      `frontend/.next-browser-tests`, free ports, summary). Still needs `PLAYWRIGHT_MODULE` because Playwright is not a
      dependency of this repo; add it to `frontend/` devDependencies if you want the command to work with no setup.
- [x] (2026-11-27, Phase 10) Automated accessibility check: `scripts/test-a11y.mjs` (axe-core, WCAG 2.1 AA) on 12 public
      pages at 1280 and 375 px, no serious or critical violation; the muted text (#5F6B64) and orange text (#A65500)
      colours were darkened to meet 4.5:1.
- [ ] Manual accessibility pass (keyboard-only, screen reader), the account and admin pages under axe, cross-browser
      mobile tests, and performance and dependency audits.

### Security
- [ ] Captcha after repeated login failures.
- [ ] Re-encode uploaded images (e.g. with `sharp`) to strip EXIF/GPS data before staff upload phone photos.
- [x] (2026-11-19) Moved to P0 ("Two tabs end the session") after the frontend review.
- [ ] During a Redis outage, the per-request session check is not mapped to a 503. Map it, and monitor Redis.
- [ ] Check that the PIN code matches the state on addresses.

### Commerce and operations
- [ ] Courier integration (e.g. Shiprocket) behind `ShippingService.applyEventInTx`. Staff enter tracking by hand today.
- [ ] Refund reconciliation: a dashboard or CSV export to match against Razorpay settlement reports.
- [x] (2026-11-27, Phase 12) OpenCart conversion tooling: `npm run convert:opencart` (phpMyAdmin JSON export ->
      import file, GST/HSN review sheet, image list, redirect map, warnings) and `npm run import:images` (local image
      folder, validated uploads, idempotent). Runbook: `docs/ops/catalogue-migration.md`.
- [ ] **Owner:** export the live OpenCart tables and the image folder, run the conversion, have the accountant fill
      `tax-review.csv`, import on staging, review the drafts, publish. OpenCart options become variants by hand.
- [ ] **Owner:** business details (`NEXT_PUBLIC_BUSINESS_*`, `SELLER_*`), home banner image, and the sign-offs in
      `docs/policies/store-policies-and-tax.md` section 5; then `npm run check:launch` must report no errors.
- [ ] Decorative Unsplash photos remain on the empty-cart and sign-in pages (a third-party request): replace them with
      owner images or remove them.
- [x] Sitemap and SEO (2026-11-20): `robots.txt`, a dynamic `sitemap.xml` (static pages, categories, every published product; survives an API outage), canonical links, Open Graph defaults, Product structured data (INR price from the server, stock, rating only when reviews exist), WebSite search data, `noindex` for search/filter/paged listings, and `X-Robots-Tag: noindex` on account, cart, checkout, auth, order, compare and admin pages.
- [ ] **Owner input for SEO:** set `NEXT_PUBLIC_BUSINESS_WEBSITE_URL` (e.g. https://yalli.in) when building for production. Without it no canonical links or sitemap URLs are emitted (a wrong host is worse than none). Also submit the sitemap in Google Search Console / Bing Webmaster Tools after launch.
- [ ] SEO later: a default social-share image (Open Graph/Twitter), an Organization logo, per-category descriptions, and `hreflang` only if you add languages.
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
