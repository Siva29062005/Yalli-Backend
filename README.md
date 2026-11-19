# Yalli Backend

Enterprise-grade e-commerce API for yalli.in (NestJS 12 · TypeScript strict · PostgreSQL · Prisma 7 · Redis · RabbitMQ).

Status: **Phase 5 (checkout & payments) implemented**: authentication/RBAC/audit, customers, catalogue & search, inventory, pricing, coupons, cart, checkout, orders, Razorpay payments + webhooks, refunds, returns, transactional outbox + RabbitMQ events. Shipping, reviews, wishlists, notifications channels, admin analytics arrive in Phase 6 — see
[docs/architecture/PROPOSAL.md](docs/architecture/PROPOSAL.md) for the approved architecture, schema, threat model and roadmap.
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
npm run check    # prettier, oxlint (type-aware), tsc, unit tests, e2e tests, build
```

## Payments
Flow, invariants, operations runbook and the honest list of what is not yet verified (live Razorpay sandbox, real broker):
[docs/architecture/phase-5-checkout-payments.md](docs/architecture/phase-5-checkout-payments.md).

## Security
Authentication, authorization and audit are documented in [docs/security/phase-3-security-foundation.md](docs/security/phase-3-security-foundation.md)
and [docs/architecture/auth-flows.md](docs/architecture/auth-flows.md). Tests run against a real PostgreSQL (embedded) with the production role split.

## Frontend
Feature map of everything this API supports (storefront, checkout, account, admin portal) with endpoint
references and API conventions: [docs/frontend/README.md](docs/frontend/README.md).

## Layout
`src/common` (envelope, filters, middleware) · `src/config` (validated env) · `src/infrastructure` (Prisma, Redis) ·
`src/health` · `prisma/` (schema + hand-written SQL migrations) · `infra/` (docker, later nginx/monitoring/ci) · `docs/`

## Conventions
- API is versioned under `/api/v1`; infra probes live at `/health/*`.
- Every response uses the envelope `{ success, message, data, meta, timestamp, requestId }`; errors never expose stacks, SQL or internals.
- Input is validated with strict Zod schemas (`@Body({ schema })`); unknown fields are rejected.
- Two database credentials: `yalli_migrator` (DDL, migrations only) and `yalli_app` (DML only). The app never sees the migrator URL.
- Secrets are never committed; production secrets come from AWS Secrets Manager. `.env.example` has placeholders only.
