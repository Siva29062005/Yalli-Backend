# Phase 9: launch-blocker fixes (2026-11-27)

The P0 items from the frontend review (2026-11-19) and the whole-app security and bug review (2026-11-27), as fixed.
Each line names the control, where it lives, and the test that proves it. Nothing here weakens an existing control.

## Money and orders

| Issue | Fix | Where | Verified by |
|---|---|---|---|
| A partial refund left the order in PARTIALLY_REFUNDED, from which it could neither ship nor take another return | A partial refund returns the order to its fulfilment state (PAID / PROCESSING / DELIVERED; RETURNED -> DELIVERED while units remain). PARTIALLY_REFUNDED is only the closing state when everything is back and delivery was kept | `refund.service.ts` `statusAfterPartialRefund` | `refunds-returns.e2e-spec.ts` "partial refunds never strand an order", second-unit return, closing state with a delivery fee |
| A staff cancel of a paid order raised an auto-approved full refund (four-eyes bypass) | Staff cancel (`actor.type ADMIN`) raises a refund in the staff member's name, PENDING_APPROVAL; a customer's own cancel stays automatic. `requestInTx` refuses auto-approval for any person-requested refund, and `refunds_human_approval_chk` refuses one past approval with no approver | `order.service.ts` `cancel`, `refund.service.ts`, migration `20261127000100_refund_human_approval` | "staff cancels a PAID order" (pending, canceller cannot approve, finance approves, DB refuses a bypass) |
| An authorized payment whose first capture failed was never captured again; an in-checkout retry after a failed attempt was ignored | AUTHORIZED stays "authorized" so reconciliation retries the capture; FAILED -> AUTHORIZED is accepted while the order is payable; only the first authorization is captured | `payment.service.ts`, `payment-state-machine.ts` | `payments.e2e-spec.ts` capture retry, retry after FAILED, one capture of two authorizations |
| Audit rows written with the shared client inside the payment transaction (pool starvation, audit row committed on rollback) | `AuditService.recordInTx(tx, …)` used for duplicate capture, amount mismatch and late capture | `audit.service.ts`, `payment.service.ts` | `pool-starvation.e2e-spec.ts` late captures + mismatches, 18 in parallel on a pool of 3 (fails with 16 x 500 on the old code) |
| Consumer de-dupe treated ANY unique violation from the work as "already processed"; a consumer read through the shared client | `runOnce` detects duplicates with INSERT … ON CONFLICT DO NOTHING; the order-events consumer reads through `tx` | `outbox/run-once.ts`, `order-events.consumer.ts` | outbox/idempotency e2e |
| Invoice numbers ("INV-" + order number) had gaps and used the calendar year | `INV/<FY>/<serial>` from `document_counters` in the transaction that marks the order PAID; existing paid orders numbered by the migration; `orders_invoice_paid_chk` ties the number to payment | `document-counter.ts`, `tax-documents.ts` `invoiceNumber`, migration `20261127000200_invoice_numbers` | `gst-credit-notes.e2e-spec.ts` "invoice numbers (GST Rule 46)"; unit format/length tests |
| Plain-text fields were stored HTML-encoded (`Kitchen &amp; Dining`), and could overflow their column (500) | `stripTags` strips markup and decodes the three entities sanitize-html emits; output never longer than input; data repair migration for existing rows | `common/utils/sanitize-html.ts`, migration `20261127000000_plain_text_entities` | unit tests; catalog and reviews e2e; migration test with colliding unique names |

## Sign-in and sessions

| Issue | Fix | Where | Verified by |
|---|---|---|---|
| Staff refresh/CSRF cookies lasted up to 7 days although "tab-scoped" | Sessions store `persistent` ("keep me signed in"); non-persistent sessions get cookies without Expires. Staff (any non-CUSTOMER role, read uncached) are never persistent and end after `STAFF_SESSION_MAX_HOURS` (12) | `auth.service.ts`, `auth-cookies.service.ts`, `authorization.service.ts` `hasStaffRole`, migration `20261127000300_session_persistent` | `tokens-sessions.e2e-spec.ts` cookie tests (no Expires, kept across refresh, staff never persistent, 12 h) |
| Every 401 triggered a refresh and a retry, so wrong MFA codes were checked twice (lockout after ~5 typos) | The JWT guard's 401 is `ACCESS_TOKEN_INVALID`; the browser refreshes only on that code | `jwt-auth.guard.ts`, `error-codes.ts`, `frontend/src/lib/token-session.ts` | "401 codes" e2e; `test-auth.mjs` (a wrong code is sent once) |
| A wrong 2FA code at sign-in went back to the password step | An unknown/used-up challenge is `MFA_CHALLENGE_EXPIRED`; only that returns to the password step | `auth.service.ts`, `LoginForm.tsx` | e2e; `test-auth.mjs` |
| Two tabs refreshing at once looked like token theft and ended the session; a refresh in one tab signed the others out (CSRF rotated) | Cookie-mode reuse within 10 s on a live session returns an access token only (`REFRESH_REUSE_GRACE_MS`, audited as `auth.refresh.grace_reuse`); outside it, or for API clients, reuse still revokes. The CSRF token stays the same for the session. Browser tabs take turns with Web Locks | `auth.service.ts`, `auth.controller.ts`, `token-session.ts` | "two TABS", "outside the grace window", "body-mode" e2e |
| Open redirect via `next=/%09/evil.com` | `safeNext` rejects control characters and backslashes, resolves with the URL parser, requires the same origin and refuses a normalised `//host` | `frontend/src/lib/safe-redirect.ts` | `safe-redirect.spec.ts` (23 cases) |
| No captcha widget, so production sign-up and password reset would fail | Turnstile widget (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) on sign-up and forgot-password; single-use tokens refreshed after each attempt | `components/Captcha.tsx`, `RegisterForm.tsx`, reset page | `test-auth.mjs` with a stubbed Turnstile (`EXPECT_CAPTCHA=1` in `npm run test:browser`) |

## Platform and frontend

| Issue | Fix | Where | Verified by |
|---|---|---|---|
| All shoppers' server-side renders shared one rate-limit bucket; `TRUST_PROXY_HOPS=0` collapsed every client into one IP | The storefront server proves itself with `FRONTEND_SERVER_KEY` (constant-time compare); its PUBLIC GET requests get a 6000/min budget instead of the per-IP rules; writes and private routes are unchanged. Production refuses `TRUST_PROXY_HOPS=0`; browser API calls go CloudFront -> ALB -> API (documented) | `rate-limit.guard.ts`, `env.ts`, `catalog-api.ts`, `docs/ops/deployment-aws.md` | catalog e2e (key / wrong key / login still limited); env spec |
| No Content-Security-Policy; tokens left in the address bar | CSP header (scripts from self, Razorpay, Turnstile; no plugins, no framing, `base-uri 'self'`), nosniff, `X-Frame-Options: DENY`, `Referrer-Policy` (no-referrer on `/auth/*`), no `X-Powered-By`. Reset/verify tokens are read once and removed from the URL | `next.config.ts`, `lib/url-token.ts` | `test-seo.mjs` header checks; `test-auth.mjs` (token removed) |
| Fixed payment Idempotency-Key per order replayed the first answer for 24 h | A new key per Pay click (`payAttemptKey`); the order is reloaded after a pay error | `checkout-api.ts`, checkout and confirmation pages | `test-checkout.mjs` |
| A failed cart merge discarded the guest cart; merge could exceed 50 lines | The guest token is cleared only on success or 400/404; the merge counts the lines it adds | `cart-api.ts`, `cart.service.ts` | cart e2e (49 + 3 = 50) |
| Finance managers could not open the coupon form | The category list loads only with `products.read`; without it, whole-cart coupons work and a category coupon keeps its categories | `admin/coupons/page.tsx` | `test-admin-screens.mjs` finance phase |
| Home page promised offers, coupons, replacements, free shipping, WhatsApp and a testimonial that do not exist | Replaced with facts; the sale card appears only while products are on sale | `app/page.tsx`, `CartDrawer.tsx`, cart page | `test-seo.mjs` (none of the claims appear) |

## Residual risks and decisions for the owner

- **CSP keeps `'unsafe-inline'` for scripts.** Next inlines its bootstrap scripts; a nonce policy forces every page to
  render per request (no static or cached pages). Revisit with Next's experimental SRI or nonces once traffic and hosting
  costs are known. The CSP still blocks scripts from other hosts, plugins and framing.
- **The refresh grace window** lets a replayed refresh cookie, within 10 seconds of its first use and on a still-active
  session, obtain one short-lived access token (no new refresh token). Reuse after that window still revokes the session.
- **Staff cancel restocks at once,** before the refund is approved. If finance rejects the refund (the goods had in fact
  shipped), correct the stock by hand; the rejection is audited.
- **Captcha after repeated login failures** is still P1 (the backend has no login captcha yet).
- **Existing credit notes** issued before the invoice-number change keep the old `INV-…` reference (credit notes are
  immutable). Only development data is affected.
