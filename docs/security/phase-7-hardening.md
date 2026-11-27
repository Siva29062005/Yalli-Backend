# Phase 7 — Hardening (implemented)

Verified by automated tests against a real PostgreSQL. Not verifiable here: AWS deployment, the CI workflow on GitHub, the DR
drill and `verify-docker.sh` Phase 7 section (they run in your Docker / on GitHub), SES, MSG91, live Razorpay.

## Independent security review
A second reviewer, who had not seen my reasoning, read the whole backend adversarially. **No Critical or High findings.**
Every finding was re-verified against the code before acting; each fix has a test that FAILS when the fix is removed.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | Cancelling a PAID order restocked every time it was repeated if the automatic refund failed | Medium | **Fixed.** Restock is single-shot (`restockCommittedInTx` flips the reservation atomically); a cancelled order whose refund fails stays `REFUND_PENDING` (never back to a shippable state) until finance refunds it. |
| 2 | Anyone could lock any account (5 wrong passwords), escalating to 24 h | Medium | **Mitigated.** Lock ceiling is now 1 hour. Residual: an anonymous caller can still cause a ≤1 h lock per account; the owner recovers through password reset. A captcha challenge after N failures is the next step (must not leak whether an account exists). |
| 3 | MFA codes could be guessed without a cumulative limit once the password is known | Medium | **Fixed.** 10 wrong second-factor attempts per account per 15 min across all logins, counted atomically before checking; audited (`auth.mfa.locked`). |
| 4 | Stock hoarding with many unpaid orders | Medium | **Fixed.** `MAX_OPEN_UNPAID_ORDERS` (default 3) per customer, race-safe under the cart lock. |
| 5 | Heavy public search only had the global limit | Low-Med | **Fixed.** Dedicated per-IP limits (120/min list, 60/min compare); trigram indexes already existed. |
| 6 | Coupon responses differ for exhausted vs invalid | Low | **Accepted.** Applying a code necessarily reveals whether it works; the per-IP limit is the control. |
| 7 | Shipping eligibility uses the address state, not the PIN code | Low | **Accepted / documented.** Only matters if state-restricted methods are configured; validate PIN↔state before relying on that. |
| 8 | Webhook event-id header is unsigned → replays with fresh ids cost provider calls | Low | **Fixed.** Replays are recognised by the signed body hash before any outbound call; recorded only after success so failed deliveries are still retried. |
| 9 | Refund webhooks were routed through the payment branch | Low | **Fixed** (and the simulator now sends real-shaped refund events with both entities). Unverified against live Razorpay. |
| 10 | Staff MFA enrolled only after the role was granted | Low | **Fixed.** A staff role can only be assigned to someone who already has confirmed MFA (`MFA_REQUIRED_FOR_STAFF`). The bootstrap SUPER_ADMIN (seeded from a secret) is the one exception: rotate its password after first sign-in. |
| 11 | Category parent loop could make public queries run away | Low | **Fixed** (`UNION` terminates). |
| 11 | Role cache can serve stale roles ≤ 60 s after revocation; SMS/email pumping limited per account/IP only; a staff member with `coupons.manage` can create a 100 % coupon | Low | **Accepted** (documented design; insider risk). |

## Found by my own testing (not the review)
- **Connection-pool deadlock in checkout.** Checkout asked the shared client for a second connection while its transaction held
  one; with enough concurrent checkouts (≥ pool size, default 10) every connection was held by a waiting transaction and all
  failed with a 500 after 5 s. Fixed; `test/commerce/pool-starvation.e2e-spec.ts` runs every transactional flow with a pool of 3
  and 9 in parallel, and a static scan found one more (an audit write on a rare refund path), also fixed.
- **MFA key rotation was impossible** (a changed key would lock out every MFA user). Retired keys now decrypt; `rotate-mfa-key`
  re-encrypts all secrets safely on a live site.
- **Timestamps were shifted on non-UTC hosts** (fixed in Phase 6).

## New controls and tooling
- Deny-by-default sweep over every documented route (anonymous → 401 except an explicit public allow-list; customers → 403 on
  all admin routes) and a fuzz of every route with hostile path/query/body input as anonymous, customer and SUPER_ADMIN:
  no 5xx, no leaked internals (`test/security/route-sweep.e2e-spec.ts`).
- Read-only, column-limited database role for reports (`yalli_reporting`).
- CI pipeline (`.github/workflows/ci.yml`: check, audit, gitleaks, Semgrep, image build + Trivy) and Dependabot — written but **not yet run** (repo not pushed).
- Load/abuse tests, runbooks and the DR drill: `docs/ops/`.

## Not done / needs you
- AWS deployment, S3 image storage, WAF, alarms (no access). Live Razorpay, SES, MSG91 checks.
- Courier integration and a guest newsletter (credit notes, GST on delivery, info/contact pages and the sitemap were added on 2026-11-19/20; roadmap items from the
  original storefront scope that were not part of the approved Phase 6 list).
- Captcha-after-failures on login; PIN↔state validation.
