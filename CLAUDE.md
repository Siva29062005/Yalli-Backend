# Yalli Backend

Security-first e-commerce API for yalli.in (single seller, INR, India/GST). NestJS 12 modular monolith on
PostgreSQL (Prisma 7), Redis, RabbitMQ. Approved architecture, schema, threat model and roadmap:
`docs/architecture/PROPOSAL.md` (section 20 = approved decisions and deviations). Storefront screenshots: `reference/`.

## Commands
- `npm run check` — the quality gate: prettier, oxlint (type-aware), tsc, unit tests, e2e tests, build. Must pass before finishing any task.
- `npm test` / `npm run test:e2e` — Vitest (unit `*.spec.ts`, e2e `*.e2e-spec.ts`). Mocks are `vi.fn()`, not `jest.fn()`.
- `npm run seed` / `docker compose --profile tools run --rm seed` — sync roles+permissions, create first SUPER_ADMIN from `BOOTSTRAP_ADMIN_*` (idempotent).
- `./scripts/setup-dev-env.sh` — creates or tops up `.env` (JWT/MFA keys, flags) without overwriting values.
- `./scripts/verify-docker.sh` — end-to-end Docker check (infra, roles, migration, hardened app container).
- `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` — generate migration SQL (needs `DATABASE_MIGRATION_URL` set to any URL; it does not connect).

## Conventions
- ESM only: relative imports end in `.js`; no `__dirname` (use `import.meta.dirname`). TypeScript strict; no `any` without a documented reason.
- Validation: strict Zod schemas via `@Body({ schema })` — unknown fields are rejected (mass-assignment defence).
- Responses use the envelope `{ success, message, data, meta, timestamp, requestId }`; errors never expose stacks, SQL or framework messages.
- API is under `/api/v1`; infrastructure probes are `/health/live` and `/health/ready`.
- Modules talk through exported services and domain events only, never another module's repository or tables.
- Hardening is configured once in `src/app.setup.ts` so `main.ts` and e2e tests run the same setup.

## Auth and access conventions (Phase 3)
- Every route must declare `@Public()`, `@Authenticated()` or `@RequirePermissions(...)`; the app refuses to boot otherwise. Add `@RequireStepUp()` to sensitive admin routes.
- Authorization data comes from the DB via `AuthorizationService` (cached 60 s; call `invalidate`), never from the JWT. Customer-owned queries filter by `principal.userId`; a foreign id is a 404.
- Request bodies use strict Zod schemas; per-route limits use `@RateLimit(...)`; security events go through `AuditService` (never put secrets in metadata).
- Role changes go through `role-policy.ts` (pure, unit-tested). Add tests for BOTH allowed and denied paths.
- E2E tests (`test/**/*.e2e-spec.ts`) use `createTestApp()` + `Scenario` helpers, a real embedded PostgreSQL and in-memory Redis/notification fakes; give each client a fresh `X-Forwarded-For` (`freshIp()`).

## Commerce conventions (Phase 4)
- Money: integer paise everywhere; the ONLY pricing function is `priceCart` (`src/modules/pricing`), the ONLY current-price rule is `effectivePrice`; SQL listing logic must stay in parity with it.
- Stock changes go through `InventoryService` only (conditional UPDATE + ledger row in one transaction); never write `inventory` directly.
- Guest-or-user routes use `@OptionalAuth()` per METHOD (not on the class when some methods need `@Authenticated`).
- Raw SQL uses `Prisma.sql` tagged templates; dynamic ORDER BY/filters come from whitelisted fragments only.
- Dates in request bodies: `z.iso.datetime({ offset: true })` (Zod `date()` cannot be expressed in the OpenAPI schema).
- Each E2E test FILE gets its own private database (cloned from the migrated template in `test/support/setup-env.ts`); tests inside one file share it, so still scope assertions to rows the test created.

## Payments / orders conventions (Phase 5)
- An order becomes PAID ONLY in `PaymentService.applyProviderPayment` (facts fetched from the provider, amount+currency checked, row-locked). Never mark paid from a request body, redirect or browser callback.
- Order status changes ONLY via `OrderLifecycleService.transition` (state machine + history + outbox). Lock order: ORDER row, then PAYMENT row.
- Refund capacity moves ONLY via `RefundService.requestInTx` (conditional UPDATE on `payments.refunded_minor`); humans need a second approver.
- Unsafe endpoints (checkout, payment start, refund create) require `Idempotency-Key` and run inside `IdempotencyService.run`.
- Domain events go through `OutboxService.add(tx, …)` inside the business transaction; never publish to the broker directly. Consumers wrap work in `MessageDeduplicator.runOnce`.
- Never call an external API inside a DB transaction unless unavoidable; fetch first, then open the transaction.
- Tests: payment tests use `FakeRazorpayApi` (real adapter + real DB). Use `ctx.drainOutbox()` (not a single `relay.tick()`), and `Shop` helpers for flows.

## Phase 6 conventions (shipping, reviews, notifications, analytics, import)
- The delivery fee is decided ONLY by `src/modules/shipping/shipping-rules.ts` (via `ShippingService.resolve`); the client sends a method CODE, never a fee. With no active method, shipping is free. Orders snapshot the method.
- Tracking changes go through `ShippingService.applyEventInTx` inside an order-locked transaction (forward-only, append-only events).
- Reviews: verified purchase only (`OrderService.hasReceivedProduct`), plain text (`cleanReviewText`), PENDING until a moderator decides; edits go back to PENDING. Anything public about a reviewer is masked.
- Notifications: account-security emails are best-effort and must never throw; order messages and OTPs must throw so callers retry. Templates are pure (`notification-templates.ts`): escape every dynamic value, never put a token in a subject or a log.
- Analytics: India calendar days, capped ranges, parameterised SQL with fixed ORDER BY fragments. Revenue = orders PAID in the period.
- Catalogue import: validate the WHOLE file first, dry-run by default, DRAFT by default, never overwrite live stock or status, stock only through the ledger (`adjustInTx`).
- Database sessions run in UTC (`PrismaService` sets it): never rely on the server time zone. Keep that regression test.
- E2E: the test body limit is 1 KB (production 100 KB), so an oversized-body test gets 413. Shipping methods are global state: reset them in `beforeEach`. Use unique tracking numbers per order.

## Phase 7 conventions (hardening)
- NEVER use the shared client (`this.prisma`, `inventory.availability()` without `db`, `coupons.findByCode()` without `db`, `audit.record`) inside a `$transaction` callback: pass the `tx`. A transaction holds one connection; asking for a second deadlocks the pool under load. `test/commerce/pool-starvation.e2e-spec.ts` (pool of 3) must pass for every new transactional flow.
- Stock returns to the shelf only via `restockCommittedInTx` (single-shot). A cancelled order whose refund fails stays `REFUND_PENDING`.
- A staff role may only be assigned to someone with confirmed MFA. MFA verification is limited per ACCOUNT (`MFA_FAIL_LIMIT`), not just per challenge.
- Any new anonymous route must be added to `PUBLIC_ROUTES` in `test/security/route-sweep.e2e-spec.ts` consciously; the sweep fails otherwise.
- Webhooks: the event-id header is not signed; dedupe also on the signed body hash. Refund events are handled as refunds.
- Reports use `ReportingDb` (read-only column-limited role); grant new report columns explicitly in a migration.
- Key rotation: MFA keys via `MFA_RETIRED_KEYS_JSON` + `rotate-mfa-key`; never swap the current key without the retired entry.
- Runbooks and the DR drill live in `docs/ops/`; security review record in `docs/security/phase-7-hardening.md`.

## Non-negotiable rules
- Deny by default: every route needs authentication and an explicit permission unless marked public. Never trust client-supplied roles, prices, totals or customer ids; customer-owned data is always queried by the authenticated customer's id (404, not 403, on a miss).
- Money is integer paise plus currency in the database and code; no floating-point arithmetic. The server computes every price, discount, tax and total.
- Login is required to purchase (guest carts allowed, merged on login). Online payment only (Razorpay); no COD.
- PostgreSQL is authoritative for orders, inventory and payments; Redis is cache/rate-limit state only.
- Two DB roles: `yalli_migrator` (DDL, migrations only) and `yalli_app` (DML only, no UPDATE/DELETE on `audit_logs`). The app never receives the migrator URL.
- Never log or return secrets, tokens, passwords or payment data. Secrets come from the environment / AWS Secrets Manager, never from the repo. Do not weaken a security control to make something pass.
- Hand-written SQL (triggers, CHECKs, partial indexes, grants) lives in the migration files and must be kept when regenerating.
- Do not claim tests passed, or a control works, without running it. Do not move to the next phase while security tests fail.

## Workflow
- Phases: 2 foundation (done) → 3 security (done; see docs/security/phase-3-security-foundation.md) → 4 core commerce (done; see docs/architecture/phase-4-commerce-core.md) → 5 checkout/payments (done; see docs/architecture/phase-5-checkout-payments.md) → 6 extras (done; see docs/architecture/phase-6-extras.md) → 7 hardening (done; see docs/security/phase-7-hardening.md and docs/ops/). Each phase ends with check + security review + a report of changed files, finished functionality and open risks.
- Nest's first-party `@nestjs/outbox`, `idempotency`, `webhooks`, `authentication`, `authorization` are not adopted yet; evaluate against the security requirements in the phase that needs them.
- Add or update tests with every change, including negative authorization tests for security-relevant endpoints. Update docs when behaviour or architecture changes.

## Environment notes (developer machine)
- Docker runs through Colima (no Docker Desktop; endpoint security removes it). `~/.docker/config.json` must not contain `credsStore: desktop`.
- Claude's shell cannot see `/Applications`; use the Docker CLI from a normal terminal or ask before running Docker steps.
- Not yet a git repository; the user will create the remote and push later. Do not commit or push unless asked.
