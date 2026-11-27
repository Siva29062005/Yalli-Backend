# Yalli: roadmap from today to a launched store

Written 2026-11-27. Phases 2-7 of `docs/architecture/PROPOSAL.md` (section 17) are done; this plan continues the numbering
from Phase 8 and takes the project to a live yalli.in that replaces the OpenCart store, with the admin console. The
individual items live in `docs/PENDING.md` (P0/P1/P2); this file orders them into phases with exit criteria. Update both
when a phase finishes.

## Where the project stands

| Area | State |
|---|---|
| Backend | NestJS 12 modular monolith, 18 modules (identity, access, audit, catalog, inventory, cart, pricing, coupons, checkout, orders, payments, refunds, shipping, reviews, customers, admin, outbox, idempotency), about 18k lines. 245 unit and 438 e2e tests on a real PostgreSQL. GST invoices, delivery GST and credit notes built. |
| Storefront | Home, catalogue and categories, search, product page, compare, wishlist, cart drawer and page, checkout with Razorpay, order confirmation, six policy pages, SEO (sitemap, robots, canonicals, structured data). All on the real API. |
| Customer account | Sign-up, sign-in with optional 2FA, password reset, email verification, profile, addresses, orders with invoice and credit notes, cancel, returns, reviews, wishlist, sessions. |
| Admin console | Staff login with mandatory MFA and step-up. Ten screens: analytics, products (editor, images, variants), categories, inventory, orders (fulfilment, tracking, cancel), refunds and returns (four-eyes approval, credit notes), coupons, shipping methods, reviews, users and roles. Permission-aware navigation. |
| Verification | Backend: `npm run check`. Frontend: tsc, lint, build, 29 unit tests, 12 Playwright scripts against fakes, plus a real-backend admin run (`npm run serve:browser`). |
| Not done | Nothing is deployed. No live Razorpay, SES, MSG91 or Turnstile yet. The catalogue is not imported. The frontend review of 2026-11-19 found 7 launch blockers and about 30 bugs (`docs/PENDING.md`). 58 changed files are uncommitted since `c33d1d9`. |

## The plan at a glance

| Phase | Goal | Blocked by | Size |
|---|---|---|---|
| 8 Stabilise | Commit the current work; one quality gate for backend and frontend | nothing | S |
| 9 Launch-blocker fixes | Close the security and correctness blockers from the review | nothing | M |
| 10 Storefront and account complete | Every customer journey works, including the old site's features | nothing (contact details need owner input) | L |
| 11 Admin complete | Staff can run the shop day to day without the database or CLI | nothing | L |
| 12 Catalogue, content and business setup | Real products, prices, fees, policies and business details | owner data, accountant, lawyer | M |
| 13 Infrastructure and live integrations | A staging environment on AWS with every real provider in test mode | AWS access, vendor accounts | L |
| 14 Pre-launch verification | Prove it on staging: regression, load, security, legal, payments | Phases 9-13 | M |
| 15 Go-live | Switch yalli.in from OpenCart with no lost orders or search ranking | Phase 14 sign-off | S |
| 16 After launch | Growth and scale features (P2) | live traffic | ongoing |

Phases 9, 10 and 11 can overlap, as can 12 and 13. Start asking for the owner inputs (end of this file) now, because they
are the critical path, not the code.

---

## Phase 8: stabilise what exists

Goal: a clean baseline so every later change is protected by one command.

- Commit and push the current working tree (GST on delivery, credit notes, SEO, review moderation, product list columns).
  The owner commits; nothing is pushed automatically.
- Bring `frontend/` into `npm run check`: frontend lint, `tsc --noEmit`, build and `vitest run frontend/src`. Keep the
  Playwright scripts opt-in, behind one wrapper (`npm run test:browser`) that starts the mock API and a frontend on a
  free port.
- Clear the P1 items in the earlier changes:
  - The listing's rating aggregate reads the reviews module's table. Move it behind `ReviewsService`.
  - Make `create-test-admin` opt-in instead of blocked only in production, and stop it printing the MFA secret.
  - `canva-prompts.md` hard-codes the categories.
- Fix stale docs:
  - `production-readiness.md` still describes `NEXT_PUBLIC_API_URL` instead of the same-origin proxy.
  - Item 11 of `deployment-aws.md` mentions GitHub Actions, which was dropped by decision.

Exit: `npm run check` covers both apps and passes; the working tree is committed.

**Status (2026-11-27): done** (committed as `108d7a4`).

## Phase 9: launch-blocker fixes

Goal: nothing a customer or attacker can trigger in the first hour of launch. Each fix gets a regression test (e2e for
the backend, a Playwright step for the frontend) and a line in a new `docs/security/phase-9-fixes.md`.

1. **Open redirect.** `safeNext` rejects control characters and compares `new URL(next, origin).origin`. Add unit tests
   with `/\t/evil.com`, `/%0a/evil.com`, `//evil.com`, `/\evil.com` and `javascript:`.
2. **Token errors.** The JWT guard returns a distinct `TOKEN_EXPIRED` code. The frontend refreshes only on that code, so
   a wrong MFA code or password is checked once, not twice. A wrong code at login keeps the customer on the code step;
   only `MFA_CHALLENGE_EXPIRED` sends them back to the password step.
3. **Two tabs.**
   - A short server grace window: the immediately previous refresh token is accepted once within about 10 seconds and
     returns the same new pair.
   - A cross-tab refresh lock in the browser (`navigator.locks`, falling back to BroadcastChannel).
   - Reuse detection outside that window is unchanged.
4. **Captcha.** A Turnstile widget on sign-up and forgot-password, and on login after repeated failures (the P1 item).
   A test key in development and fakes in tests.
5. **Server-side rate limit.** The Next server forwards the shopper's IP in a header the backend trusts only from the
   frontend's network (or the backend gives the frontend's own requests a separate, larger budget). Add a load-smoke
   test for it.
6. **Payment retries.** A fresh `Idempotency-Key` per Pay click, reused only for network retries of that click. Reload
   the order after a pay error.
7. **Guest cart.** Clear the guest token only after a successful merge, or a 400/404.
8. **Finance coupons.** The coupon form works without the category list (all items only), or categories are readable
   with `coupons.manage`. Add allowed and denied e2e tests.
9. **Home page claims.**
   - Remove the bundles offer, WELCOME100, "replacement", "free shipping above ₹499", WhatsApp and the testimonial.
   - Build the offer strip from real data instead: active shipping methods, live coupons marked public, on-sale products.
10. **Security headers.** A Content-Security-Policy (Razorpay and Turnstile allowed, nonce-based scripts) and
    `Referrer-Policy: no-referrer` on `/auth/*`. Remove reset and verify tokens from the URL after reading them.

11. **From the 2026-11-27 security and bug review** (P0 in `docs/PENDING.md`):
    - the partial-refund dead end
    - staff cancel bypassing four-eyes
    - capture retry for authorized payments
    - audit writes inside the payment transaction
    - invoice numbering per financial year
    - plain text stored HTML-encoded (fix before the catalogue import in Phase 12)
    - staff session cookies
    - client IP through the Next proxy

**Status (2026-11-27): done.** All 18 items fixed with tests; record in `docs/security/phase-9-fixes.md` (with the
residual risks: CSP keeps `'unsafe-inline'` for Next's inline scripts, the 10-second refresh grace window, staff cancel
restocks before approval). Login captcha after repeated failures stays P1.

Exit: all P0 "Frontend review" and "Security and bug review" items in `docs/PENDING.md` ticked; `npm run check` and the browser scripts pass;
security review recorded.

## Phase 10: storefront and customer account complete

Goal: every journey a customer of the old site had, plus the account features the backend already supports.

**Bugs** (the P1 "Frontend review: bugs" list for storefront, cart, checkout and account):
- **Cart:**
  - the "−" button over stock
  - an error status shown as an empty cart
  - checkout errors that never reload the quote
  - the wrong unavailable-items message for an unserved PIN code
  - the 503 wording
  - one cart drawer in the layout
  - consistent item counts
- **Confirmation page:** polling errors and the stale `?payment=` parameter.
- **Account:**
  - return rules on the order page (window, units already returned, reload after a request)
  - address field errors
  - `meta`-based paging, including the wishlist provider
  - opening the invoice window first
  - `AuthProvider` treating a 5xx as a sign-out
  - logout across tabs
  - `next` kept on sign-up
- **Storefront:**
  - `/catalog/all-products` and 404 for unknown categories
  - categories in the server HTML
  - the India time zone in `formatIndianDate`
  - price boxes that follow navigation
  - accessibility labels and focus in the filter dialog

**Features the backend already has:**
- change password
- phone verification by OTP
- sign out of all devices
- turn off 2FA with a recovery code
- resend the verification email
- order timeline and payment deadline
- product names in the returns list
- all reviews (paged) with the star distribution
- a "from" price on multi-variant products
- a brand filter scoped to the category

**Features that need backend work too:**
- **Self-service account deletion and data export** (DPDP; `DELETE /me` and `POST /me/export` exist, the screens do
  not).
- **A contact form.** It was on the old site and in the Phase 6 scope but was never built. A rate-limited, captcha-guarded
  `POST /contact` that emails support and stores the message, plus the form on `/contact`.
- **Brand pages** (`/brands`, `/brands/[slug]`), from the old site's Brands menu.
- **Specials page** (`/specials`), using the existing `special` filter.

Exit: the Playwright storefront, cart, checkout and account scripts cover each item; an automated accessibility check
(axe) runs on the main pages with no serious issues; the P1 storefront and account items are ticked.

## Phase 11: admin console complete

Goal: staff can run the shop without SQL, a terminal or a developer.

**Bugs** (P1 "Frontend review: bugs", admin):
- empty page after the last row of a page is acted on
- inventory history page kept across SKUs
- "Adjust" ignoring the row's warehouse
- the Categories gate and step-up
- variant saves sending price fields
- the cancel form closing on failure
- the role picker listing roles the caller cannot assign

**Screens over existing endpoints:**
- brand create and delete
- restore archived products
- edit slug
- reorder images, and images per variant
- product picker for product-scoped coupons
- returns status filter
- returns linked from order detail
- invoice and credit notes on admin order detail
- tracking event time
- take down an approved review

**New backend plus screen:**
- **Finance:**
  - Credit-note register by date with a GSTR-1-ready CSV export.
  - Refund reconciliation export against Razorpay settlements.
  - Retry for a failed refund (still four-eyes).
- **Support:** customer lookup (`customers.read`: profile, orders, returns; masked contact details, audited views).
- **Security:** an audit-log viewer (`audit.read`, through `ReportingDb`).
- **Inventory:** low-stock thresholds and warehouses editable.
- **Notifications:** the credit note emailed as a document with the refund email.
- **Catalogue import in the console:** upload, dry-run report, then confirm. It wraps the existing CLI rules: validate
  the whole file, DRAFT by default, stock through the ledger. The CLI is enough for launch if time is short.

Exit: `test-admin-screens.mjs` (fake) and `test-admin-real.mjs` (real backend) drive every new screen; negative
permission tests for every new endpoint; `lib/admin-access.ts` updated.

## Phase 12: catalogue, content and business setup

Goal: the new store holds the real shop, not test data. Mostly owner work, supported by tooling.

- Import the OpenCart catalogue: 258 products, 7 top-level categories with subcategories, brands and images, from an
  export of the live store. The images need the S3 adapter from Phase 13, or a local import on staging first. Review
  them as DRAFT, then publish.
- Set the GST rate and HSN code per product, opening stock per SKU, shipping methods and fees, and the launch coupons
  (if any).
- Business details:
  - the `NEXT_PUBLIC_BUSINESS_*` settings (legal name, registered address, GSTIN, support contacts)
  - the grievance officer
  - `SELLER_LEGAL_NAME`, `SELLER_STATE` and `SELLER_GSTIN`
  - `NEXT_PUBLIC_BUSINESS_WEBSITE_URL`
- Sign-offs:
  - The accountant confirms the GST rules (delivery apportioning, credit-note format, goodwill refunds).
  - The lawyer reviews the privacy, terms and returns pages.
  - Change the pages if either asks.
- Home page content from real data: categories, on-sale products, newest products. Banner images supplied by the owner.

Exit: the staging catalogue matches the live site; policy pages show real details; sign-offs recorded in
`docs/policies/store-policies-and-tax.md`.

## Phase 13: infrastructure and live integrations

Goal: a staging environment on AWS that is identical to production except for test-mode keys. Follows
`docs/ops/deployment-aws.md`.

- **Code:**
  - The S3 `ObjectStorage` adapter (production refuses local disk).
  - Image re-encoding with `sharp` to strip EXIF/GPS.
  - The reservation sweeper as its own worker.
  - A Redis outage mapped to 503.
  - The frontend built as a Next `standalone` container.
- **Hosting:**
  - CloudFront → ALB (TLS, WAF) → ECS Fargate running the API, the worker and the Next frontend.
  - The frontend proxies `/api/v1` internally, so the browser stays same-origin.
  - RDS PostgreSQL (Multi-AZ, PITR), ElastiCache Redis, Amazon MQ, Secrets Manager.
  - The three database roles.
  - `TRUST_PROXY_HOPS=2`.
- **Deploys without CI** (owner decision): a local `scripts/deploy.sh` that refuses to run unless `npm run check` passes,
  builds and scans the images, runs migrations as `yalli_migrator`, then rolls out.
- **Providers in test mode:**
  - Razorpay test keys end to end: payment, webhook to the staging URL, refund.
  - SES with the domain verified (SPF/DKIM/DMARC).
  - MSG91 with a DLT-approved OTP template.
  - Turnstile and HIBP.
- **Operations:** CloudWatch alarms (5xx, p99, DB connections, outbox backlog, DLQ), backups, and the DR drill on staging
  (`scripts/dr-drill.sh`).

Exit: staging is reachable over HTTPS; a test customer can register (email and SMS received), pay with Razorpay test
mode, get the order shipped, return it, and receive a refund and credit note; the DR drill passes.

## Phase 14: pre-launch verification on staging

Goal: evidence, not assumptions, that the store is ready.

- **Full regression:** `npm run check`, every Playwright script against staging, and the real-backend admin run.
- **Load test** (`docs/ops/load-testing.md`) at about 3 times the expected peak; check catalogue caching, the
  rate-limit budgets and the database pool.
- **Security:**
  - an OWASP ZAP baseline and an external pen test if affordable
  - the dependency audit
  - container scan
  - CSP report-only first, then enforced
  - a review record in `docs/security/`
- **Quality:**
  - accessibility (keyboard, screen reader, contrast)
  - real phones (Android Chrome, iOS Safari)
  - Lighthouse performance on product and catalogue pages
- **Business:**
  - Razorpay live activation and website review (policy pages linked from the footer, domain matching checkout)
  - live keys stored in Secrets Manager
  - SES production access

Exit: a signed launch checklist in `docs/ops/` with each item's evidence.

## Phase 15: go-live

Goal: replace OpenCart without losing orders, customers' trust or search ranking.

- **Old URLs:** 301 redirects from the OpenCart URLs (`index.php?route=product/product&product_id=…`, category and
  information routes) to the new slugs, generated from the import mapping. Without them, existing Google rankings are lost.
- **Cut-over:** freeze orders on the old store, ship or refund its open orders there, and lower the DNS TTL in advance.
  Customer accounts are not migrated: passwords cannot be carried over safely, so customers register again. Announce this.
- **First order:** one real live payment and refund by the owner, then open the store. Submit the sitemap to Search Console
  and Bing.
- **Watch:** alarms, the outbox backlog, payment success rate and 4xx/5xx for the first 72 hours; the rollback is the
  previous image (migrations are additive).

Exit: live orders paid and shipped; the old store closed and redirecting.

## Phase 16: after launch (P2, ordered by expected value)

1. Courier integration (e.g. Shiprocket) behind `ShippingService.applyEventInTx`, replacing manual tracking.
2. Search: stemming and typo tolerance (OpenSearch), recently viewed, related products by behaviour.
3. Catalogue read caching or denormalised price columns once traffic needs it.
4. Newsletter and marketing email, only with recorded consent (the sign-up flag exists; sending does not).
5. Reviews: helpfulness votes, photos, seller replies.
6. Split shipments, partial cancellation, multi-warehouse reservations.
7. Cash on delivery: deliberately excluded at approval (PROPOSAL section 20). Revisit only with its own payment state,
   fraud rules and remittance reconciliation.
8. Sign-in anomaly detection, a slower hash for recovery codes, exactly-once notification sending, an approval step for
   imports, and an evaluation of Nest's first-party outbox, idempotency and webhooks packages.

---

## Owner inputs (the critical path)

| Needed | For | Phase |
|---|---|---|
| Decision: commit now | baseline | 8 |
| Turnstile site and secret keys (free Cloudflare account) | captcha | 9 |
| Product export from OpenCart (CSV/SQL dump and the image folder) | import | 12 |
| Legal name, registered address, GSTIN, state, support email and phone, hours | invoices, policy pages | 12 |
| Grievance officer name, designation, email and phone | Consumer Protection (E-Commerce) Rules | 12 |
| GST rate and HSN code per product, opening stock, shipping fees | pricing and invoices | 12 |
| Accountant sign-off (delivery GST, credit notes) and lawyer review (policies) | launch | 12 |
| AWS account access and the domain's DNS | staging and production | 13 |
| Razorpay test keys now, live keys at Phase 14 | payments | 13, 14 |
| SES domain verification, MSG91 account with DLT sender and template | email and SMS | 13 |
| Go-live date and a freeze window for the old store | cut-over | 15 |

## Rules that hold in every phase

Everything in `CLAUDE.md` applies. In particular:
- `npm run check` passes before a phase ends, and every security-relevant endpoint has allowed and denied tests.
- No demo data, and no claims (discounts, free shipping, legal review) the shop does not honour.
- Each phase ends with a short report: changed files, finished functionality, open risks. `docs/PENDING.md` and
  `CLAUDE.md` are updated.
