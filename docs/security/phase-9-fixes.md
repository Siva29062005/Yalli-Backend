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
- **The refresh grace window** lets a replayed refresh COOKIE, within 10 seconds of its first use and on a still-active
  session, obtain at most two short-lived access tokens (no new refresh token). A token sent in the request body never
  gets grace. Reuse after that window, or a third replay, still revokes the session.
- **Deploy the backend before the frontend:** the browser refreshes only on `ACCESS_TOKEN_INVALID`, so a new frontend in
  front of an old backend would stop refreshing expired access tokens (the user would have to reload).
- **An authorization that can never be captured** (the provider keeps rejecting the capture) keeps its order from
  expiring until the provider voids it (days); reconciliation retries the capture every 2 minutes. Watch the
  `Capture of authorized payment failed` log line.
- **Captcha after repeated login failures** is still P1 (the backend has no login captcha yet).
- **Existing credit notes** issued before the invoice-number change keep the old `INV-…` reference (credit notes are
  immutable). Only development data is affected.

## Follow-up review of the Phase 9 commit (2026-11-27)

An adversarial review of commit `02eff2a` found, and this follow-up fixed:

| Issue | Fix | Verified by |
|---|---|---|
| A cancelled order with an earlier partial refund went back to PAID when its cancel refund failed or was rejected (shippable after restock) | `recompute` checks `cancelledAt` before the partial-refund branch | "after a partial refund, a customer cancel whose refund FAILS stays cancelled-and-waiting" |
| A rejected staff cancel left the order stuck in REFUND_PENDING, already restocked | A staff cancel only REQUESTS the cancellation (pending refund, nothing restocked); the order is cancelled and restocked when the refund is PROCESSED (`markPaidOrderCancelledInTx`); a rejected or failed refund returns the order to where it was | "only REQUESTS it", "a REJECTED staff cancel leaves the order where it was" |
| A second authorization could be captured after a capture that timed out but worked (double charge); capture could loop | One capture attempt at a time (`payments.capture_started_at` claim, stale after 2 minutes); an already-captured provider payment is applied instead of capturing another; an authorization for the wrong amount is a `mismatch` (no capture, order can expire) | "NO DOUBLE CHARGE", "authorization for the wrong amount", migration `20261127000400_payment_capture_claim` |
| Any client could get the refresh grace window by adding `X-Auth-Mode: cookie` to a body token | Grace (and the kept CSRF token) only when the refresh token came from the cookie | "a body token sent WITH X-Auth-Mode: cookie gets no grace" |
| A staff role granted after sign-in rode on the customer session (persistent, 30 days) | Granting any non-customer role signs the person out everywhere (`ROLE_ASSIGNED`); the next sign-in is a staff sign-in | authorization e2e |
| Unlimited access tokens within the grace window | At most `REFRESH_REUSE_GRACE_MAX` (2) per refresh token | "at most two extra access tokens" |
| The claim-loser branch of the tab race was only tested by chance | Deterministic test (the claim is taken by "another tab" between read and claim) | "the tab that LOSES the atomic claim" |
| The storefront budget was counted twice (both rate-limit guards) | Only the IP guard owns IP budgets | "each keyed request counts ONCE" |
| Captcha: no message or retry when Turnstile cannot load | Message with "try again", the failed script is removed, `role="group"` | `test-auth.mjs` |
| CSP blocked a configured cross-origin `NEXT_PUBLIC_API_URL` | Its origin is added to `connect-src` | build |
| A failing guest-cart merge hid the customer's own cart | Fall back to the user's cart, keep the guest token for a later merge | `test-cart.mjs` |
| Coupon form said "needs product access" when the category list merely failed to load | Distinct message | `test-admin-screens.mjs` |
| Admin sign-in stayed on the code step after an expired challenge | Back to the password step on `MFA_CHALLENGE_EXPIRED` | `test-admin-access.mjs` |

Not changed on purpose: order line snapshots (`order_items.product_name`) written before the `stripTags` fix keep the
encoded text, because order lines are immutable records; only development data is affected.

## Second follow-up (review of `e19076c`, 2026-11-27)

| Issue | Fix | Verified by |
|---|---|---|
| A customer cancel after a REJECTED staff cancel restocked and marked the order cancelled but refunded nothing (the idempotency lookup returned the rejected refund), and the order could still ship | Every cancel attempt gets its own refund key (`cancel:<order>`, then `cancel:<order>:<n>`) once earlier ones were rejected or failed; the customer cancel requests its refund FIRST and only then cancels the fulfilment; fulfilment refuses any order with `cancelledAt` | "after a REJECTED staff cancel, the customer can still cancel" |
| A repeated staff cancel after a rejection silently did nothing | Same per-attempt key: a new PENDING refund appears for approval | "a staff cancel can be requested again after a rejection" |
| The `pendingRefundApproval` audit flag was set for every staff cancel | Set only when a staff refund was actually requested | code review |
| The "no double charge" test did not exercise the already-captured branch | New test: stale claim, then a second authorization's webhook applies the capture that happened, with no capture call | "NO DOUBLE CHARGE (stale claim)" |
| A body-mode (API) session could still get the refresh grace window by sending its token as a cookie with a self-chosen CSRF pair | Sessions record `cookie_mode` at sign-in; only cookie-mode sessions get grace (migration `20261127000500_session_cookie_mode`) | "a session issued in BODY mode gets no grace" |
| Re-granting a role the person already holds signed them out | No-op when the role is already held | "re-granting a role … signs nobody out" |
| Captcha: the error stayed after Turnstile recovered; "try again" could not recover from a script that loaded without Turnstile | Error cleared on a token; the broken script is forgotten and removed | `test-auth.mjs` |

Residual (accepted): a sign-in already in progress when a staff role is granted could, in a window of milliseconds, create a
customer-type session after the revocation; the person still needs MFA, and the next refresh keeps its customer limits.
If Razorpay does not yet list a capture that timed out (beyond the 2-minute claim), a second authorization could be
captured; capture calls time out after 10 s, so this needs the provider to lag by minutes.


## Review of the Phase 10 commit (`da146bc`, 2026-11-27)

| Issue | Fix | Verified by |
|---|---|---|
| A 5-emoji contact message passed the 10-character check (UTF-16 length) and failed in PostgreSQL (500) | Length counted in code points, as Zod and PostgreSQL do | contact e2e "too little text" |
| The per-address contact limit ran BEFORE the captcha: anyone could burn a customer's budget with junk requests | The limiter keeps only the per-IP budget (10/hour); the per-address cap (3/hour) counts stored messages after the captcha passed | "counts the per-address cap only after the captcha passed", "is rate-limited per IP address as well" |
| The contact request waited for the support email (a slow SES held it open) | Send not awaited (stored first; failures logged); SES client has connect/request timeouts | code review |
| The support email did not warn that sender details are unverified (social engineering of support staff) | Footnote: name, email and order number are not verified; check the order's email before sharing details | template |
| Brand counts (and brand pages) included products with no active variant | `brands()` requires an active variant; a brand with no buyable product is a 404 | "brand counts leave out products with no active variant", `test-catalog.mjs` (`/brands/gone`) |
| Account export and deletion ignored contact-form messages sent from the account's address | Export includes them; deletion erases them | customers e2e (export, erasure) |
| Signing out in one tab: the tab received its own broadcast and was sent to the login page; a 4xx `/me` was retried; a failed retry left a stale session | Broadcasts carry the tab id; only network/5xx errors are retried; giving up clears the session; `endLocally()` for flows the server already ended (sign out everywhere, deletion) | `test-account.mjs` |
| Change password showed the server's 401 text and bare field errors | Clear wording for a wrong current password and for new-password rules | `test-account.mjs` |
| After deletion the customer landed on the home page with no confirmation | `/?account=deleted` shows a status message | `test-account.mjs` |
| Export filename used the UTC date; the blob URL was revoked before some browsers started the download | India date; revoked after 10 s | `test-account.mjs` (filename) |
| A failed credit-note render left an empty popup | The window is closed and an error shown | code review |
| Profile: verify controls were nested in `<label>`s; Enter in the SMS box submitted the profile form | Controls moved next to the labels; Enter verifies the code | `test-account.mjs`, axe |
| /specials and /brands/x offered "On sale"/"Clear all" for their own fixed filter, and a category change dropped it | `locked` filters: not clearable, carried into `/catalog/<category>` as query filters | `test-catalog.mjs` |
| A cart load could overwrite the answer of an edit made while it was in flight (stale lines) | A load only applies if no newer edit has answered | code review |
| "Show more reviews" could repeat reviews (page 1 is a cached render) and kept offering more after a short page | De-duplicated by id; stops on a short page | code review (`test-compare-reviews.mjs` paging still passes) |
| Checkout: a delivery method that was switched off showed no reason; stock, coupon and empty-cart refusals did not refresh the cart and quote; an older quote could overwrite a newer one; a failed coupon removal was invisible | Own message for `INVALID_METHOD`; those codes reload cart + quote; only the newest quote request may set it; the cart error banner is on checkout | code review (`test-checkout.mjs` still passes) |
| Price boxes started from the raw URL (`min=abc`), not the normalised query | Initialised from the parsed query | `test-catalog.mjs` |
| The home tiles said "categories unavailable" when only the background revalidation failed (server tiles shown) | The banner only shows when there are no real tiles | code review |

Residual (not verified): build-time category fetch in the root layout adds the API's latency to every uncached render;
it is revalidated on mount and degrades to the "All" tile, but its cost was not measured.
