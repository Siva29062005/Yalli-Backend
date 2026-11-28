# Launch checklist (Phase 14 exit)

Yalli replaces the OpenCart store only when every row below has evidence and the owner has signed at the end. "Evidence"
is something another person can check: a command and its result, a report file, a screenshot, a date. Work through it on
**staging** (never production, except the rows marked *live*). Status: ✅ done with evidence · 🟡 done locally, repeat on
staging · ⬜ open.

Commands referred to: `npm run check` (the quality gate), `npm run test:browser` (fake-backend browser scripts),
`npm run serve:browser` + `frontend/scripts/test-admin-real.mjs` (real-backend staff run), `npm run verify:site -- --url
<site> [--production]` (read-only checks of a deployed site; run `npm run build` first, it runs the compiled file), `node scripts/load/run.mjs` (load), `./scripts/deploy.sh` (deploy).

## 1. Regression

| # | Item | How | Evidence | Status |
|---|---|---|---|---|
| 1.1 | Quality gate on the release commit | `npm run check` | 2026-11-28, commit of Phase 14: passed (unit, e2e, build, frontend lint/build/tsc) | 🟡 |
| 1.2 | Browser scripts (fakes) | `npm run test:browser` | last full run 2026-11-27 (Phase 13): all scripts passed | 🟡 |
| 1.3 | Real-backend staff run | `serve:browser` + `test-admin-real.mjs` | last run 2026-11-27: every staff screen | 🟡 |
| 1.4 | Deployed site checks | `npm run verify:site -- --url https://staging…` (also run by `deploy.sh` with `SITE_URL`) | local rehearsal 2026-11-28 over http: 37 checks, 0 failed; https-only checks (HSTS, redirect) need staging | 🟡 |
| 1.5 | Exit test of Phase 13 on staging | register (email + SMS arrive), pay with Razorpay test mode, ship, return, refund, credit note | | ⬜ |
| 1.6 | Restore drill on staging | `scripts/dr-drill.sh` (docs/ops/backup-restore.md) | | ⬜ |
| 1.7 | Old store addresses redirect | `frontend/src/data/legacy-redirects.json` from the final conversion; `npm run verify:redirects -- --site <rehearsal host> --urls old-urls.txt` (docs/ops/go-live.md) | resolver unit-tested (65 cases); fixed routes, 404s and untouched pages checked by `test-static-pages.mjs`; `verify:site` checks two | ⬜ |

## 2. Load (docs/ops/load-testing.md)

Expected peak: **owner to supply** (orders and visitors per hour on the busiest day of the old store). Target: 3× that.

| # | Item | How | Evidence | Status |
|---|---|---|---|---|
| 2.1 | Storefront pages at 3× peak (≥95% of the rate answered, only 2xx/3xx), p99 within budget | `run.mjs --url <frontend> --scenario storefront --rate <3× peak> --max-p99 1500` | local baseline 2026-11-28 (dev machine, real app, every page incl. home): 883 req/s, p99 30 ms, all 200 | ⬜ |
| 2.2 | Catalogue API search at 3× peak | `--scenario catalog` against staging | | ⬜ |
| 2.3 | Limiters engage, nothing else breaks | `--scenario login-flood`, `--scenario register` | in-repo smoke in `npm run check` (`test/load/`) | 🟡 |
| 2.4 | Database pool and RDS connections stay below the alarm | CloudWatch during 2.1/2.2 | | ⬜ |
| 2.5 | CloudFront caches the catalogue (hit ratio) | CloudFront metrics during 2.1 | | ⬜ |

## 3. Security

| # | Item | How | Evidence | Status |
|---|---|---|---|---|
| 3.1 | Dependency audit, both apps | `npm audit` in `/` and `frontend/` | 2026-11-28: 0 vulnerabilities in both (the `effect` advisory fixed with an override) | ✅ |
| 3.2 | Container scan | trivy in `deploy.sh` (HIGH/CRITICAL stop the deploy) | | ⬜ |
| 3.3 | CSP rolled out: report-only first, then enforced | staging deploy with `CSP_REPORT_ONLY=1` in the frontend env file, a full checkout with real Razorpay and Turnstile, zero "CSP violation" log lines; then remove it and deploy again (a new frontend image: the tag carries the build settings) | | ⬜ |
| 3.4 | OWASP ZAP baseline | `docker run --rm -v "$PWD:/zap/wrk:rw" -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t https://staging… -r zap.html` (passive only; run by the owner, Docker) | | ⬜ |
| 3.5 | External penetration test (if affordable) | | | ⬜ |
| 3.6 | Security review record | `docs/security/phase-14-verification.md` | written 2026-11-28 | ✅ |
| 3.7 | Open P1 security items decided (fix or accept, in writing) | `docs/PENDING.md`, "Security and bug review 2026-11-27: fix soon" | 2026-11-28: all fixed with tests (`docs/security/phase-16-p1-fixes.md`); the amount-mismatch refund stays manual by decision | ✅ |
| 3.8 | Secrets only in Secrets Manager; live keys rotated in after testing | AWS console review | | ⬜ |

## 4. Quality

| # | Item | How | Evidence | Status |
|---|---|---|---|---|
| 4.1 | Automated accessibility (axe, WCAG 2.1 AA) | `test-a11y.mjs` in `npm run test:browser` | 12 public pages, 1280 and 375 px, no serious/critical issue | 🟡 |
| 4.2 | Keyboard-only pass: sign-up, catalogue, cart, checkout, account | by hand | | ⬜ |
| 4.3 | Screen reader pass (VoiceOver on iOS, TalkBack on Android) on the same journeys | by hand | | ⬜ |
| 4.4 | Real phones: Android Chrome and iOS Safari, a full order | by hand on staging | | ⬜ |
| 4.5 | Lighthouse on home, a catalogue page and a product page (mobile) | `npx lighthouse <url> --form-factor=mobile` or Chrome DevTools | | ⬜ |

## 5. Business and providers

| # | Item | How | Evidence | Status |
|---|---|---|---|---|
| 5.1 | Business details and launch check | `npm run check:launch` with both apps' production values | | ⬜ |
| 5.2 | Accountant sign-off (delivery GST, credit notes) and lawyer review (policies) | `docs/policies/store-policies-and-tax.md` section 5 | | ⬜ |
| 5.3 | Razorpay live activation and website review | policy pages linked in the footer, checkout domain matches | | ⬜ |
| 5.4 | Live Razorpay keys and webhook secret in Secrets Manager | | | ⬜ |
| 5.5 | SES production access, domain verified (SPF/DKIM/DMARC) | | | ⬜ |
| 5.6 | MSG91 DLT sender and OTP template approved | | | ⬜ |
| 5.7 | Turnstile site with the real hostnames (production refuses the test secret) | | | ⬜ |
| 5.8 | Catalogue imported, reviewed and published | docs/ops/catalogue-migration.md | | ⬜ |

## 6. Operations

| # | Item | How | Evidence | Status |
|---|---|---|---|---|
| 6.1 | Alarms exist and fire (5xx, p99, tasks, RDS, outbox, DLQ, Redis, payment mismatch) | trigger each once on staging | | ⬜ |
| 6.2 | Rollback rehearsed | `./scripts/deploy.sh staging --rollback <previous commit>` | | ⬜ |
| 6.3 | Runbooks read by whoever is on call | docs/ops/incident-runbooks.md | | ⬜ |

## Sign-off

| Role | Name | Date | Signature / note |
|---|---|---|---|
| Owner | | | |
| Developer | | | |
