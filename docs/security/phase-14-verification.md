# Phase 14: pre-launch verification (2026-11-28)

Phase 14 needs a staging environment that does not exist yet (no AWS access). This record covers what was built and
verified locally so that the staging run is a matter of running commands, and the controls tightened because a scan of
the deployed site would flag them. The evidence table for launch is `docs/ops/launch-checklist.md`.

## Verification tooling

| Tool | What it checks | Where | Verified by |
|---|---|---|---|
| `npm run verify:site -- --url <site>` | Read-only checks of a deployed site: http→https redirect, HSTS, CSP (enforced, `frame-ancestors`/`object-src 'none'`, no `'unsafe-eval'`, named script hosts, reporting), nosniff, X-Frame-Options, Referrer-Policy (`no-referrer` on `/auth`), `X-Robots-Tag` on private pages, robots.txt and sitemap host, API success and error envelopes with nothing internal (stack, SQL, Prisma, server paths, Express or HTML error pages), `no-store` on private answers, catalogue cacheable, foreign-origin CORS refused, Swagger and `/.env`/`/.git` not served. Never signs in, never writes: safe against production | `src/cli/verify-site.ts`, pure checks in `src/common/site-checks.ts` | `site-checks.spec.ts` (each check passes a good answer and fails a bad one); local rehearsal against the real app behind `next start`: 41 checks, 0 failed |
| `deploy.sh` runs it | after every deploy and rollback when `SITE_URL` is set; a failure stops with the rollback command | `scripts/deploy.sh`, `deploy/example.env` | dry run |
| Storefront load scenario | Next.js page renders (home, catalogue, specials, brands, help, uncached searches) with `--rate` (3× peak) and `--max-p99` | `scripts/load/run.mjs` | local run: 711 req/s, p99 47 ms, 10 664 × 200, 0 errors (an early version hit a redirect for half the requests; fixed to `/catalog`) |
| Launch checklist | every Phase 14 item with how, evidence and status; owner sign-off | `docs/ops/launch-checklist.md` | |

## Controls tightened

| Issue | Fix | Where | Verified by |
|---|---|---|---|
| API answers had no Cache-Control, so tokens, MFA secrets, `/me` and exports could be kept by a browser or by CloudFront once it sits in front of the API | Every API answer is `no-store` unless the route sets its own (public catalogue, JWKS, media) | `app.setup.ts` | `http-hardening.e2e-spec.ts` (`/me`, 401, login, 404 are no-store; categories stay `public, max-age=60`) |
| A Turnstile token solved for one form or on another site was accepted on any form | The server passes the expected action (`register`, `forgot_password`, `contact`) and checks `action` and `hostname` (the storefront's hosts from `FRONTEND_BASE_URL` and the CORS origins). Cloudflare's test secrets answer `example.com` and no action, so with one only `success` counts, and production refuses a test secret | `captcha.adapters.ts`, `ports.ts`, the three callers, `env.ts` | `captcha.adapters.spec.ts`; `env.spec.ts` |
| Production would start with emailed links to localhost, reports on the app role, or Redis/RabbitMQ without TLS | Production refuses a non-https or localhost `FRONTEND_BASE_URL`, a missing `REPORTING_DATABASE_URL`, `redis://` and `amqp://` | `env.ts` | `env.spec.ts` (a complete production configuration passes; each of these fails) |
| The app verifies the database certificate (`rejectUnauthorized`) but Node does not trust Amazon's RDS CAs: staging could not connect | The API, worker and migrate images contain Amazon's RDS CA bundle, pinned by SHA-256, via `NODE_EXTRA_CA_CERTS`; the migrator URL uses `sslmode=verify-full&sslrootcert=…` | root `Dockerfile` | **not built here** (Docker runs on the owner's machine): `./scripts/verify-docker.sh`, then staging |
| No way to see what the CSP blocks in shoppers' browsers, and no safe way to roll it out | The CSP names `report-uri /api/v1/csp-reports`; `POST /api/v1/csp-reports` (anonymous, 30/min per IP, both browser formats, nothing stored) logs one line per violation ("CSP violation") with only origin+path of each URL (query strings can hold reset tokens) and printable characters. `CSP_REPORT_ONLY=1` at build time sends the policy as report-only; the launch check and `deploy.sh` refuse it for production | `modules/csp-reports`, `next.config.ts`, `app.setup.ts` (body types), `launch-config.ts`, `deploy.sh` | `csp-report.spec.ts`; `http-hardening.e2e-spec.ts` (both formats 204, token not logged, junk 400, oversized 413, limit 429); route sweep (on the public list) |
| The storefront sent no HSTS (only the API did) | `Strict-Transport-Security: max-age=63072000; includeSubDomains` on https builds; no `preload` (the owner's decision, hard to undo) | `next.config.ts` | `verify-site` checks it on staging |
| `effect` ReDoS advisory (GHSA-7589-6fvf-x4pw) through the Prisma CLI (in the migrate image) | npm override `effect@3.22.4` | `package.json` | `npm audit`: 0 vulnerabilities (backend and frontend); `prisma validate` and the migrations in `npm run check` |

## Residual risks and what remains

- Everything that needs staging: the https-only checks, the load test at 3× peak, ZAP, the container scan on real
  images, CSP report-only with real Razorpay and Turnstile, real phones, Lighthouse, the providers in test and live mode.
- The CSP keeps `'unsafe-inline'` for scripts (Next inlines its bootstrap; nonces would make every page dynamic). Unchanged
  from Phase 9.
- The CSP report endpoint is anonymous by nature: anyone can add log lines (bounded per IP, sanitised, nothing stored).
  Alarm on a sudden rise rather than on any line.
- The open P1 security items in `docs/PENDING.md` (MFA lockout escalation, refund lock order, staff backdating delivery,
  shared refresh cookie for admin and storefront, …) are not fixed by this phase: the launch checklist (3.7) requires a
  written fix-or-accept decision for each before go-live.
