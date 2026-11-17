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

Capacity notes: the API pool is 10 connections per instance (`DATABASE_POOL_MAX`); put the catalogue behind a CDN (responses
are `Cache-Control: public, max-age=30`); search varies by query and is rate limited to 120/min per IP.
