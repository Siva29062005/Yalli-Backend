# Phase 16 (part 1): the open P1 items of the 2026-11-27 review (2026-11-28)

Before any new feature, the owner chose to close every open "fix soon" item from the whole-app review
(`docs/PENDING.md`, "Security and bug review 2026-11-27"). Each line: the problem, the fix, where, and the test that proves it.

## Money, orders, events

| Problem | Fix | Where | Verified by |
|---|---|---|---|
| Rejecting or failing a refund locked the refund and payment rows before the order: deadlock (40P01) against a refund request or the payment webhook on the same order | Every refund transaction (reject, provider refund, failure, the finish helpers) locks the ORDER first, then the payment | `refund.service.ts` | the full refunds and pool-starvation suites |
| The refund webhook recorded its event id, then did the work in a second transaction: a failure was acknowledged as done | One transaction for the event id and the work (`applyProviderRefundInTx`); the mismatch audit stays outside it | `payment.service.ts`, `refund.service.ts` | `refunds-returns.e2e-spec.ts` "work fails ... retry processes it" |
| A payment for another amount was re-reconciled, re-audited and re-alarmed every 2 minutes for 48 hours | Reported once (`failure_code = AMOUNT_MISMATCH`), skipped by reconciliation; the money is refunded by a person (runbook), never automatically (it would bypass refund capacity and four-eyes) | `payment.service.ts`, `commerce-worker.ts`, `docs/ops/incident-runbooks.md` | `payments.e2e-spec.ts` "reported ONCE" |
| An authorization the provider kept refusing to capture kept its order (and stock) open for days | Cancelled like any unpaid order an hour after the payment window; the authorization lapses | `commerce-worker.ts` | `payments.e2e-spec.ts` "never lets us capture" |
| Refund requests were not audited | `refund.requested` once per request (not on an idempotent replay) | `commerce.controllers.ts` | `refunds-returns.e2e-spec.ts` |
| The outbox relay could publish a later event of an order before an earlier one that failed | Only the oldest unpublished event of each aggregate is claimed (partial index migration `20261128000000_outbox_aggregate_order`) | `outbox-relay.ts` | `outbox-idempotency-authz.e2e-spec.ts` "holds back the LATER events of its own aggregate only" |
| Staff could backdate delivery (closing the return window, delivery before shipping) | A tracking time before the shipment or its latest update is refused (compared at minute precision, like the console's time field) | `shipping.service.ts` | `shipping.e2e-spec.ts`; `test-admin-real.mjs` (refused, then the current minute accepted) |
| Delivery fees and switching methods off (free delivery) needed only `shipments.manage` | Creating a method, or changing fee, free-above or active, needs `pricing.update` (an unchanged value is no change); the console hides those controls | `shipping.service.ts`, `admin/shipping/page.tsx` | `shipping.e2e-spec.ts` (ORDER_MANAGER allowed and denied paths) |

## Identity and access

| Problem | Fix | Where | Verified by |
|---|---|---|---|
| About 960 MFA guesses a day with a known password; the owner was not told | A daily cap (30) on top of the 15-minute window; the first refusal of each lock emails the owner (`MFA_LOCKED`) | `mfa.service.ts`, `notification-templates.ts` | `password-mfa.e2e-spec.ts` |
| Turning MFA on left older password-only sessions alive | Every other session is signed out | `mfa.service.ts` | `password-mfa.e2e-spec.ts` |
| Export/delete re-authentication skipped the per-account code counter | `verifySecondFactor` (counted, locked), only after a correct password | `account.service.ts` | `password-mfa.e2e-spec.ts` |
| A password change left a reset link usable; a reset worked on a suspended account; a pending sign-in challenge survived a reset | Reset links deleted on change; reset refused unless ACTIVE/PENDING; challenges carry the password's change time and die when it changes | `account-security.service.ts`, `auth.service.ts` | `password-mfa.e2e-spec.ts` |
| `@RequirePermissions()` with no names meant "any signed-in user" | The decorator throws where it is written; the start-up auditor rejects an empty list | `access.decorators.ts`, `access-policy.auditor.ts` | `access.decorators.spec.ts` |
| Two SUPER_ADMINs could suspend each other at once | Serializable, the last ACTIVE SUPER_ADMIN cannot be suspended, the actor must still be active | `admin-access.service.ts` | `admin-access.service.spec.ts`; `authorization.e2e-spec.ts` (race) |
| Account deletion kept IP, user agent and device in `user_sessions` | Scrubbed in the deletion transaction | `account.service.ts` | `customers.e2e-spec.ts` |
| One refresh cookie for console and storefront: signing in to one signed the other out | The console sends `X-Auth-Mode: cookie-admin` and gets `yalli_rt_admin`/`yalli_csrf_admin`; refresh, CSRF and sign-out use the pair named by the header | `auth-cookies.service.ts`, `constants/auth.ts`, `token-session.ts`, `admin-session.ts` | `tokens-sessions.e2e-spec.ts`; `test-admin-access.mjs` |

## Platform and catalogue

| Problem | Fix | Where | Verified by |
|---|---|---|---|
| Dev `app`/`seed` containers received the migrator and superuser credentials | Emptied in their environment; production refuses to start with `DATABASE_MIGRATION_URL` | `docker-compose.yml`, `env.ts` | `env.spec.ts` |
| The migrations' REVOKEs depend on the role existing; a later role or broad GRANT gives UPDATE/DELETE back | Start-up check of the login's privileges on the append-only tables: production refuses, otherwise a warning; repair SQL documented | `infrastructure/database/privilege-check.ts`, `docs/ops/database-roles.md` | `db-privileges.e2e-spec.ts` |
| `*.code` redaction hid error codes; Prisma validation errors can print query arguments | Precise redaction paths; Prisma validation errors logged by kind only | `common/logging/log-safety.ts` | `log-safety.spec.ts` |
| Dev examples used port 5173 for CORS and email links | 3001, with the CSRF/captcha role of the list documented | `.env.example`, `setup-dev-env.sh` | (configuration) |
| "Verified purchase" stayed after every unit was returned and refunded | Net of REFUNDED returns, both for writing a review and for the public badge | `order.service.ts` (`customersWhoKept`), `reviews.service.ts` | `reviews-wishlist.e2e-spec.ts` |
| Deleting a variant needed only `products.update`; category counts included products with no active variant | `products.delete`; counts need an active variant (like the listing and brand counts) | `catalog-admin.controller.ts`, `catalog-query.service.ts`, `ProductEditor.tsx` | `catalog.e2e-spec.ts` |

## Review of these fixes (commit 9b3ba2d)

Two independent reviews; all findings confirmed and fixed:
- **The daily MFA cap counted CORRECT codes too** (high): an owner who signs in and steps up often was locked out for a
  day, with a false "compromised" email. Now only failures count; the 30th failure sets a lock marker (with its end, for
  Retry-After); a completed password reset clears every counter and lock; the email no longer claims the password was used.
- **A wrong-amount capture after a wrong-amount authorization was never reported** (the usual Razorpay order): the marks
  are now per stage (`AMOUNT_MISMATCH_AUTHORIZED`, then `AMOUNT_MISMATCH`), each stage audits and logs the alarm once,
  only the captured stage stops reconciliation; a failed attempt keeps the mark; reconciliation prefers an authorization
  for the right amount.
- **The Prisma log serializer never ran in the app** (pino-http wraps it and passes the serialized object): it now
  recognises both shapes; the test goes through pino-http.
- **A revoke and a suspension at once could still leave no active SUPER_ADMIN**: `revokeRole` counts only ACTIVE holders
  other than the target (which also makes the two conflict under SERIALIZABLE) and requires an active actor.
- **Backdating on old shipments**: never more than 3 days back (`MAX_BACKDATE_MS`); the entered time is audited.
- **States served** changes need `pricing.update` (opening a free method to all of India); the console locks them.
- **A password reset could lift a concurrent suspension**: the update is conditional on the status read.
- **Column-level UPDATE grants** are caught by the privilege check (`has_any_column_privilege`); tested with real grants.
- **Outbox order** now uses the database clock (`clock_timestamp()` default, migration `20261128000100`), and a head that
  keeps failing logs "Outbox event stuck" (alarm, runbook).
- **Audits after commit could be lost**: the refund request and the refund-amount mismatch are audited inside their
  transactions (`recordInTx`).
- Tests that proved too little: the backdating test now separates the latest-update rule from the ship date and the
  3-day cap; a concurrency test runs reject + request on one order; the dev compose `app` no longer gets
  `BOOTSTRAP_ADMIN_*`, the `seed` no longer the reporting password.

## Residual

- The amount-mismatch refund stays manual by design.
- The privilege check covers the tables the migrations protect; a new append-only table must be added to
  `FORBIDDEN_PRIVILEGES` with its REVOKE.
- An existing developer `.env` keeps `CORS_ALLOWED_ORIGINS=http://localhost:5173` (the setup script never overwrites):
  change it to `http://localhost:3001`.
