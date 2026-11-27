# Yalli Backend

Enterprise-grade e-commerce API for yalli.in (NestJS 12 · TypeScript strict · PostgreSQL · Prisma 7 · Redis · RabbitMQ).

Status: **backend Phases 2-7 implemented** (authentication/RBAC/audit, catalogue and search, inventory, pricing, coupons,
cart, checkout, Razorpay payments and webhooks, refunds and returns, GST invoices and credit notes, shipping, reviews,
notifications, analytics, outbox + RabbitMQ, hardening), plus a Next.js storefront, customer account and admin console in
[frontend/](frontend/). Not deployed yet. Architecture: [docs/architecture/PROPOSAL.md](docs/architecture/PROPOSAL.md);
the plan to launch: [docs/ROADMAP.md](docs/ROADMAP.md); open work: [docs/PENDING.md](docs/PENDING.md).
Reference screenshots of the current storefront are in [reference/](reference/).

## Requirements
- Node.js >= 26, npm >= 11
- Docker (Docker Desktop, or Colima + docker CLI) for PostgreSQL / Redis / RabbitMQ and integration tests

## Quick start
```bash
npm install                      # also runs `prisma generate`
./scripts/setup-dev-env.sh       # creates .env with random dev secrets, or tops up a legacy .env (never overwrites values)
docker compose up -d             # postgres, redis, rabbitmq (bound to 127.0.0.1)
docker compose --profile tools run --build --rm migrate   # applies migrations as the DDL role
docker compose --profile tools run --rm seed     # roles + permissions (+ first SUPER_ADMIN if BOOTSTRAP_ADMIN_* is set)
npm run start:dev                # http://localhost:3000  (health: /health/live, /health/ready; Swagger: /docs in dev)
```

## Rebuild the Docker app image after code changes
The `app` service (profile `app`) runs the compiled image, so it does not see new code until it is rebuilt. Migrations are
only needed when `prisma/migrations` changed. From the repo root, with the infrastructure running:
```bash
docker compose --profile app up -d --build --wait app
```
Then check it is the new code (an unauthenticated call must answer 401, not 404) and look at the log:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/v1/admin/users
docker compose --profile app logs --tail 30 app
```
If a release adds a migration, run `docker compose --profile tools run --build --rm migrate` first; if it changes roles or
permissions, run `docker compose --profile tools run --rm seed` after. `./scripts/verify-docker.sh` runs the whole chain.

## Quality gate
```bash
npm run check            # backend: prettier, oxlint (type-aware), tsc, unit + frontend unit specs, e2e, build;
                         # then check:frontend: eslint (no warnings), next build, tsc
npm run check:frontend   # the frontend part only
```
Browser regressions (opt-in; Playwright is not a dependency of this repo):
```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:browser   # all fake-backend scripts
npm run test:browser -- --only cart,seo --skip-build                   # some scripts, reuse the last test build
```
It starts the catalogue mock API, builds the storefront into `frontend/.next-browser-tests` (never touching `.next`), starts
it on free ports and prints a summary. The real-backend admin run is separate: `npm run serve:browser`, then
`frontend/scripts/test-admin-real.mjs`.

## Test admin (development only)
```bash
npm run build
NODE_ENV=development ALLOW_TEST_ADMIN=1 TEST_ADMIN_EMAIL=dev-admin@example.test TEST_ADMIN_PASSWORD='…' \
  npm run create:test-admin
```
Creates an extra SUPER_ADMIN with MFA already enrolled. It refuses to run without both flags, never changes an existing
user, and writes the MFA secret to an owner-only file in the OS temp folder (the path is printed): add it to an
authenticator app, then delete the file.

## Payments
Flow, invariants, operations runbook and the honest list of what is not yet verified (live Razorpay sandbox, real broker):
[docs/architecture/phase-5-checkout-payments.md](docs/architecture/phase-5-checkout-payments.md).

## Security
Authentication, authorization and audit are documented in [docs/security/phase-3-security-foundation.md](docs/security/phase-3-security-foundation.md)
and [docs/architecture/auth-flows.md](docs/architecture/auth-flows.md). Tests run against a real PostgreSQL (embedded) with the production role split.

## Frontend
Next.js 16 app in [frontend/](frontend/) (storefront, account, admin console), served same-origin with `/api/v1` proxied to
the API. Run it with `npm run dev -- --port 3001` in `frontend/`. Status and conventions:
[docs/frontend/production-readiness.md](docs/frontend/production-readiness.md) and the Frontend section of
[CLAUDE.md](CLAUDE.md).

## Layout
`src/common` (envelope, filters, middleware) · `src/config` (validated env) · `src/infrastructure` (Prisma, Redis) ·
`src/health` · `prisma/` (schema + hand-written SQL migrations) · `infra/` (docker, later nginx/monitoring/ci) · `docs/`

## Conventions
- API is versioned under `/api/v1`; infra probes live at `/health/*`.
- Every response uses the envelope `{ success, message, data, meta, timestamp, requestId }`; errors never expose stacks, SQL or internals.
- Input is validated with strict Zod schemas (`@Body({ schema })`); unknown fields are rejected.
- Two database credentials: `yalli_migrator` (DDL, migrations only) and `yalli_app` (DML only). The app never sees the migrator URL.
- Secrets are never committed; production secrets come from AWS Secrets Manager. `.env.example` has placeholders only.
