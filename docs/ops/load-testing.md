# Load testing

In-repo smoke (runs in `npm run test:e2e`): `test/load/load-smoke.e2e-spec.ts` and `test/commerce/pool-starvation.e2e-spec.ts`
prove, with real HTTP and a real database, that there are no 5xx under concurrency, abuse is bounded by the limiters, stock is
never oversold, and no flow needs a second database connection while holding one.

Against a **staging** instance (never production):
```bash
node scripts/load/run.mjs --url https://staging.example --scenario catalog     --duration 30 --connections 50 --spoof-ip
node scripts/load/run.mjs --url https://staging.example --scenario login-flood --duration 10        # shows the limiter engaging
node scripts/load/run.mjs --url https://staging.example --scenario register    --duration 10
```
`--spoof-ip` only works if staging runs with `TRUST_PROXY_HOPS=1` and the test hits the app directly (not through a CDN).
The run exits non-zero on any 5xx, dropped connection or timeout. Record requests/second and p99 per release.

Storefront pages (the Next.js server, its API reads and the root layout's category fetch, and the shared
`frontend-server` budget): point `--url` at the FRONTEND.
```bash
node scripts/load/run.mjs --url https://staging.example --scenario storefront --duration 60 --connections 50 \
  --rate <3x the expected peak, requests/second> --max-p99 1500
```
Catalogue results load in the browser (the API `catalog` scenario covers search), so this measures server renders.
`--rate` fixes the request rate; `--max-p99` fails the run above that latency. Expected peak comes from the old store's
busiest day (owner input); Phase 14 tests at 3× that (`docs/ops/launch-checklist.md`, section 2). Run through CloudFront
(the real path, which also shows the cache hit ratio): the WAF rate rule blocks a single test machine, so add a
temporary WAF allow rule for the test machine's IP address for the duration of the run and remove it afterwards (the ALB
accepts only CloudFront, so it cannot be targeted directly). The run fails if fewer than 95% of `--rate` were answered or
if any page answered other than 2xx/3xx (a WAF 403 is not a pass).

Capacity notes: the API pool is 10 connections per instance (`DATABASE_POOL_MAX`); put the catalogue behind a CDN (responses
are `Cache-Control: public, max-age=30`); search varies by query and is rate limited to 120/min per IP.
