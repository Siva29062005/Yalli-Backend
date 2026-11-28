# Phase 14: pre-launch verification (2026-11-28)

Phase 14 needs a staging environment that does not exist yet (no AWS access). This record covers what was built and
verified locally so that the staging run is a matter of running commands, and the controls tightened because a scan of
the deployed site would flag them. The evidence table for launch is `docs/ops/launch-checklist.md`.

## Verification tooling

| Tool | What it checks | Where | Verified by |
|---|---|---|---|
| `npm run verify:site -- --url <site>` | Read-only checks of a deployed site: http→https redirect, HSTS, CSP (enforced, `frame-ancestors`/`object-src 'none'`, no `'unsafe-eval'`, named script hosts, reporting), nosniff, X-Frame-Options, Referrer-Policy (`no-referrer` on `/auth`), `X-Robots-Tag` on private pages, robots.txt and sitemap host, API success and error envelopes with nothing internal (stack, SQL, Prisma, server paths, Express or HTML error pages), `no-store` on private answers, catalogue cacheable, foreign-origin CORS refused, `/.env`/`/.git` not served (Swagger is not checked: it is mounted outside `/api/v1`, which CloudFront never sends to the API, and production refuses `SWAGGER_ENABLED`). Never signs in, never writes: safe against production | `src/cli/verify-site.ts`, pure checks in `src/common/site-checks.ts` | `site-checks.spec.ts` (each check passes a good answer and fails a bad one); local rehearsal against the real app behind `next start`: 37 checks, 0 failed |
| `deploy.sh` runs it | after every deploy (with `--production` on production: a report-only CSP fails) and rollback when `SITE_URL` is set; `SITE_URL` must be the frontend's site address; a failure after a deploy stops with the rollback command, after a rollback it is reported | `scripts/deploy.sh`, `deploy/example.env` | dry run |
| Storefront load scenario | Next.js page renders (home, catalogue, specials, brands, help, shipping, uncached searches) with `--rate` (3× peak; fails below 95% of it) and `--max-p99`; any status other than 2xx/3xx fails | `scripts/load/run.mjs` | local run: 883 req/s, p99 30 ms, 17 658 × 200 |
| Launch checklist | every Phase 14 item with how, evidence and status; owner sign-off | `docs/ops/launch-checklist.md` | |

## Controls tightened

| Issue | Fix | Where | Verified by |
|---|---|---|---|
| API answers had no Cache-Control, so tokens, MFA secrets, `/me` and exports could be kept by a browser or by CloudFront once it sits in front of the API | Every API answer is `no-store` unless the route sets its own (public catalogue, JWKS, media); every ERROR is `no-store`, also on those routes | `app.setup.ts`, `all-exceptions.filter.ts` | `http-hardening.e2e-spec.ts` (`/me`, 401, login, 404 are no-store; categories stay `public, max-age=60`) |
| A Turnstile token solved for one form or on another site was accepted on any form | The server passes the expected action (`register`, `forgot_password`, `contact`) and checks `action` and `hostname` (the storefront's hosts from `FRONTEND_BASE_URL` and the CORS origins). Cloudflare's test secrets answer `example.com` and no action, so with one only `success` counts, and production refuses a test secret | `captcha.adapters.ts`, `ports.ts`, the three callers, `env.ts` | `captcha.adapters.spec.ts`; `env.spec.ts` |
| Production would start with emailed links to localhost, reports on the app role, or Redis/RabbitMQ without TLS | Production refuses a non-https or localhost `FRONTEND_BASE_URL`, a missing `REPORTING_DATABASE_URL`, `redis://` and `amqp://` | `env.ts` | `env.spec.ts` (a complete production configuration passes; each of these fails, also a reporting URL with the app user) |
| The app verifies the database certificate (`rejectUnauthorized`) but Node does not trust Amazon's RDS CAs: staging could not connect | The API, worker and migrate images contain Amazon's RDS CA bundle, pinned by SHA-256, via `NODE_EXTRA_CA_CERTS`. Prisma's migration engine has its own TLS: the migrate image holds the region's RSA2048 root on its own and `prisma.config.ts` refuses a migrator URL without `sslmode=require&sslaccept=strict&sslcert=…` (and refuses `verify-full`/`sslrootcert` everywhere, which Prisma ignores) | root `Dockerfile`, `scripts/extract-rds-root.mjs`, `prisma.config.ts` | `test/migration-url.spec.ts`; **not built here** (Docker runs on the owner's machine): `./scripts/verify-docker.sh`, then staging |
| No way to see what the CSP blocks in shoppers' browsers, and no safe way to roll it out | The CSP names `report-uri /api/v1/csp-reports`; `POST /api/v1/csp-reports` (anonymous, its own 30/min per IP that does NOT use the visitor's shop budget, `application/csp-report` parsed on this route only, nothing stored) logs one line per violation ("CSP violation") with only origin+path of each URL (query strings can hold reset tokens) and printable characters. `CSP_REPORT_ONLY=1` at build time sends the policy as report-only; the launch check and `deploy.sh` refuse it for production | `modules/csp-reports`, `next.config.ts`, `app.setup.ts` (body types), `launch-config.ts`, `deploy.sh` | `csp-report.spec.ts`; `http-hardening.e2e-spec.ts` (204, token not logged, junk 400, oversized 413, limit 429, 310 reports leave the shop budget alone, the report type is not parsed on /auth/login); route sweep (on the public list) |
| The storefront sent no HSTS (only the API did) | `Strict-Transport-Security: max-age=63072000; includeSubDomains` on https builds; the API sends the same (its `preload` was removed: asking browsers to hard-code the domain is the owner's decision, hard to undo) | `next.config.ts` | `verify-site` checks it on staging |
| `effect` ReDoS advisory (GHSA-7589-6fvf-x4pw) through the Prisma CLI (in the migrate image) | npm override `effect@3.22.4` | `package.json` | `npm audit`: 0 vulnerabilities (backend and frontend); `prisma validate` and the migrations in `npm run check` |

## Review of the Phase 14 commit (1c1ab35)

Two independent reviews; all 18 findings confirmed and fixed:
- **Migrator TLS was not verified** (Prisma's engine ignored `verify-full`/`sslrootcert` and fell back to `prefer`): fixed as
  above (single root, `sslaccept=strict`, refused otherwise); the engine is now downloaded at build time.
- **BuildKit**: `deploy.sh` requires `docker buildx` (the Dockerfile's `ADD --checksum` needs it).
- **CSP reports used up the visitor's global budget**: own budget (`replacesGlobal`).
- **Report-only could not be undone for the same commit** (frontend tag reused): the tag carries a hash of the build
  arguments; rollback finds the frontend revision by `<sha>-<env>-`.
- **Load test**: `/` and `/brands` were never requested (shared counter); a server that could not keep up, or a WAF that
  blocked everything, passed. Now every page in turn, the achieved rate must be ≥95% of `--rate`, non-2xx/3xx fails.
- **Catalogue errors were publicly cacheable**: the exception filter sets `no-store`.
- `application/csp-report` was parsed as JSON on every route (browsers send it cross-site): now on the report route only;
  the unused Reporting API format was removed (and null fields accepted).
- verify-site: the Swagger and `..` checks tested nothing (removed); `--production` fails a report-only CSP.
- `REPORTING_DATABASE_URL`: the worker and CLI tasks need it too (documented); one with the app user is refused.
- `deploy.sh`: a failed check after a rollback is reported, not "deploy stopped"; `SITE_URL` must be the frontend's site.
- Docs: the load test runs through CloudFront with a temporary WAF allow rule (the ALB only accepts CloudFront); HSTS
  `preload` removed from the API to match the recorded decision; `verify:site` needs a build first.

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
