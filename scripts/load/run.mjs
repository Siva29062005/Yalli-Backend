#!/usr/bin/env node
// Load and abuse scenarios against a RUNNING instance (never point this at production).
//   node scripts/load/run.mjs --url http://127.0.0.1:3000 --scenario catalog [--duration 15] [--connections 30] [--spoof-ip]
//
// Scenarios
//   health       GET /health/live                        baseline for the HTTP stack
//   catalog      GET /api/v1/catalog/products?q=...      the heaviest public query (each request searches a different term)
//   login-flood  POST /api/v1/auth/login, wrong password  the Argon2 denial-of-service defence: cost must stay bounded by the limits
//   register     POST /api/v1/auth/register               abuse of account creation
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

const result = await autocannon({ url, connections, duration, requests });
const codes = Object.fromEntries(
  Object.entries(result.statusCodeStats).map(([k, v]) => [k, v.count]),
);
const serverErrors = Object.entries(codes)
  .filter(([k]) => k.startsWith('5'))
  .reduce((n, [, c]) => n + c, 0);
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
    },
    null,
    2,
  ),
);
// A load test passes only if the service never answered with a 5xx and never dropped a connection.
process.exit(
  serverErrors === 0 && result.errors === 0 && result.timeouts === 0 ? 0 : 1,
);
