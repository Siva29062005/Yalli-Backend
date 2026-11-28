#!/usr/bin/env node
// Load and abuse scenarios against a RUNNING instance (never point this at production).
//   node scripts/load/run.mjs --url http://127.0.0.1:3000 --scenario catalog [--duration 15] [--connections 30] [--spoof-ip]
//                             [--rate <requests per second>] [--max-p99 <ms>]
//
// Scenarios
//   health       GET /health/live                        baseline for the HTTP stack
//   catalog      GET /api/v1/catalog/products?q=...      the heaviest public query (each request searches a different term)
//   login-flood  POST /api/v1/auth/login, wrong password  the Argon2 denial-of-service defence: cost must stay bounded by the limits
//   register     POST /api/v1/auth/register               abuse of account creation
//   storefront   GET pages of the Next.js storefront      --url is the FRONTEND: home, catalogue, search, help pages.
//                                                         Searches make every render uncached, so this measures the
//                                                         server render plus its API reads (the root layout's category
//                                                         fetch) and the shared frontend-server budget (X-Frontend-Key)
//
// --rate fixes the request rate (e.g. 3x the expected peak) instead of "as fast as possible"; the run FAILS if the
// server could not keep up (fewer than 95% of that rate answered: a slow server otherwise looks fast because fewer
// requests are measured). --max-p99 fails the run when the 99th percentile latency is above that many milliseconds.
// The storefront scenario also fails on any status that is not 2xx/3xx (a WAF 403 or a limiter 429 is not a pass).
//
// --spoof-ip sends a different X-Forwarded-For per request. It only has an effect when the target runs with TRUST_PROXY_HOPS=1
// (a test environment); without it every request comes from one address, which is exactly what you want for login-flood
// (it shows the per-IP limiter engaging).
import autocannon from 'autocannon';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')
    ? args[i + 1]
    : fallback;
};
const url = opt('url', 'http://127.0.0.1:3000');
const scenario = opt('scenario', 'health');
const duration = Number(opt('duration', 15));
const connections = Number(opt('connections', 30));
const spoof = args.includes('--spoof-ip');
const rate = opt('rate') ? Number(opt('rate')) : undefined;
const maxP99 = opt('max-p99') ? Number(opt('max-p99')) : undefined;

const rnd = () => randomBytes(4).toString('hex');
const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const json = { 'content-type': 'application/json' };

const scenarios = {
  health: () => [{ method: 'GET', path: '/health/live' }],
  catalog: () => [
    {
      method: 'GET',
      setupRequest: (r) => ({
        ...r,
        path: `/api/v1/catalog/products?q=${rnd()}&page=1`,
      }),
    },
  ],
  'login-flood': () => [
    {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: json,
      setupRequest: (r) => ({
        ...r,
        body: JSON.stringify({
          email: `nobody-${rnd()}@example.com`,
          password: 'definitely-wrong-password',
        }),
      }),
    },
  ],
  storefront: () => {
    const pages = ['/', '/catalog', '/specials', '/brands', '/help', '/shipping'];
    let i = 0;
    return [
      {
        method: 'GET',
        setupRequest: (r) => {
          i += 1;
          // every third request is a search (never cached); the others walk through EVERY page in turn
          const path = i % 3 === 0 ? `/catalog?q=${rnd()}` : pages[(i - Math.floor(i / 3) - 1) % pages.length];
          return { ...r, path };
        },
      },
    ];
  },
  register: () => [
    {
      method: 'POST',
      path: '/api/v1/auth/register',
      headers: json,
      setupRequest: (r) => ({
        ...r,
        body: JSON.stringify({
          firstName: 'Load',
          lastName: 'Test',
          email: `load-${rnd()}@example.com`,
          phone: `+9198${Math.floor(10000000 + Math.random() * 89999999)}`,
          password: `Tr0ub4dor&3-${rnd()}-horse`,
          newsletter: false,
          acceptPrivacyPolicy: true,
        }),
      }),
    },
  ],
};

if (!scenarios[scenario]) {
  console.error(
    `Unknown scenario "${scenario}". Choose: ${Object.keys(scenarios).join(', ')}`,
  );
  process.exit(2);
}

const requests = scenarios[scenario]().map((r) => ({
  ...r,
  ...(spoof
    ? {
        setupRequest: (req, ctx) => {
          const next = r.setupRequest ? r.setupRequest(req, ctx) : req;
          return {
            ...next,
            headers: {
              ...(next.headers ?? r.headers ?? {}),
              'x-forwarded-for': ip(),
            },
          };
        },
      }
    : {}),
}));

const result = await autocannon({
  url,
  connections,
  duration,
  requests,
  ...(rate ? { overallRate: rate } : {}),
});
const codes = Object.fromEntries(
  Object.entries(result.statusCodeStats).map(([k, v]) => [k, v.count]),
);
const serverErrors = Object.entries(codes)
  .filter(([k]) => k.startsWith('5'))
  .reduce((n, [, c]) => n + c, 0);
// abuse scenarios EXPECT 4xx (the limiters); a page load test does not
const unexpected =
  scenario === 'storefront'
    ? Object.entries(codes)
        .filter(([k]) => !/^[23]/.test(k))
        .reduce((n, [, c]) => n + c, 0)
    : 0;
const achieved = result.requests.average;
const rateOk = !rate || achieved >= 0.95 * rate;
console.log(
  JSON.stringify(
    {
      scenario,
      connections,
      durationSeconds: duration,
      requestsPerSecond: Math.round(result.requests.average),
      latencyMs: {
        p50: result.latency.p50,
        p97_5: result.latency.p97_5,
        p99: result.latency.p99,
        max: result.latency.max,
      },
      statusCodes: codes,
      networkErrors: result.errors,
      timeouts: result.timeouts,
      serverErrors,
      ...(scenario === 'storefront' ? { unexpectedStatuses: unexpected } : {}),
      ...(rate ? { targetRate: rate, rateOk } : {}),
      ...(maxP99 ? { maxP99, p99Ok: result.latency.p99 <= maxP99 } : {}),
    },
    null,
    2,
  ),
);
// A load test passes only if the service never answered with a 5xx, never dropped a connection and (with --max-p99)
// stayed under the latency budget.
process.exit(
  serverErrors === 0 &&
    unexpected === 0 &&
    rateOk &&
    result.errors === 0 &&
    result.timeouts === 0 &&
    (!maxP99 || result.latency.p99 <= maxP99)
    ? 0
    : 1,
);
