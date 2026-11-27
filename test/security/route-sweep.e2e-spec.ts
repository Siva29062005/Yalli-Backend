import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  Scenario,
  authed,
  createTestApp,
  freshIp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
});
afterAll(() => ctx.close());

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const SAMPLE_UUID = '00000000-0000-7000-8000-000000000001';

function routes() {
  const doc = SwaggerModule.createDocument(
    ctx.app,
    new DocumentBuilder().setTitle('sweep').setVersion('1').build(),
  );
  const out: { method: (typeof METHODS)[number]; path: string; url: string }[] =
    [];
  for (const [path, item] of Object.entries(doc.paths))
    for (const method of METHODS)
      if ((item as Record<string, unknown>)[method])
        out.push({
          method,
          path,
          url: path
            .replace(
              /\{(id|userId|variantId|paymentId|orderId)\}/g,
              SAMPLE_UUID,
            )
            .replace(/\{[^}]+\}/g, 'sample-slug'),
        });
  return out;
}

/**
 * The ONLY routes an anonymous caller may reach (everything else must answer 401). Adding a route here is a security
 * decision: it must be public on purpose (auth entry points, the catalogue, guest cart, public reviews).
 */
const PUBLIC_ROUTES = new Set([
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/mfa/verify',
  'GET /api/v1/catalog/products',
  'GET /api/v1/catalog/compare',
  'GET /api/v1/catalog/products/{slug}',
  'GET /api/v1/catalog/categories',
  'GET /api/v1/catalog/brands',
  'GET /api/v1/catalog/products/{slug}/reviews',
  'GET /api/v1/catalog/products/{slug}/reviews/summary',
  // guest-or-user cart (merged into the account on login)
  'GET /api/v1/cart',
  'DELETE /api/v1/cart',
  'POST /api/v1/cart/items',
  'PATCH /api/v1/cart/items/{variantId}',
  'DELETE /api/v1/cart/items/{variantId}',
  'POST /api/v1/cart/coupon',
  'DELETE /api/v1/cart/coupon',
  // contact form (rate-limited, captcha)
  'POST /api/v1/contact',
]);
const key = (r: { method: string; path: string }) =>
  `${r.method.toUpperCase()} ${r.path}`;

describe('deny by default (every documented route)', () => {
  it('anonymous callers get 401 everywhere except the explicit public list - and that list has no stale entries', async () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(100);
    const leaks: string[] = [];
    for (const r of all) {
      const res = await ctx.http()[r.method](r.url).send({});
      const isPublic = PUBLIC_ROUTES.has(key(r));
      if (!isPublic && res.status !== 401)
        leaks.push(`${key(r)} answered ${res.status} to an anonymous caller`);
      if (isPublic && res.status === 401)
        leaks.push(`${key(r)} is on the public list but demands a login`);
    }
    expect(leaks).toEqual([]);
    const known = new Set(all.map(key));
    expect([...PUBLIC_ROUTES].filter((p) => !known.has(p))).toEqual([]);
  });

  it('a signed-in CUSTOMER gets 403 on every admin route', async () => {
    const customer = await s.session();
    const wrong: string[] = [];
    let checked = 0;
    for (const r of routes().filter((x) =>
      x.path.startsWith('/api/v1/admin'),
    )) {
      const res = await ctx
        .http()
        [r.method](r.url)
        .set(authed(customer))
        .send({});
      checked += 1;
      if (res.status !== 403) wrong.push(`${key(r)} answered ${res.status}`);
    }
    expect(checked).toBeGreaterThan(40);
    expect(wrong).toEqual([]);
  });
});

describe('hostile input never produces a server error or leaks internals', () => {
  const NASTY = [
    "'; DROP TABLE users;--",
    '../../../../etc/passwd',
    '%00',
    '${7*7}',
    '<script>alert(1)</script>',
    'ä'.repeat(200),
    '0'.repeat(300),
  ];
  const LEAK =
    /(\bat [\w.<>$ ]+ \(|node_modules|\/Users\/|prisma|PrismaClient|SELECT |INSERT |syntax error|stack)/i;

  /** Every request has its own client address, so the IP rate limiter does not swallow the fuzzing. */
  async function fuzz(
    list: ReturnType<typeof routes>,
    actorFor: () => Promise<{ accessToken: string; ip: string } | null>,
  ) {
    const problems: string[] = [];
    const stats: Record<number, number> = {};
    for (const r of list) {
      const actor = await actorFor();
      for (const bad of NASTY) {
        const url = r.path
          .replace(/\{[^}]+\}/g, encodeURIComponent(bad))
          .concat(
            `?q=${encodeURIComponent(bad)}&page=${encodeURIComponent(bad)}&by=${encodeURIComponent(bad)}`,
          );
        let req = ctx.http()[r.method](url);
        req = actor
          ? req.set({ ...authed(actor), 'X-Forwarded-For': freshIp() })
          : req.set('X-Forwarded-For', freshIp());
        const res = await req.send({
          x: bad,
          name: bad,
          __proto__: { admin: true },
          constructor: bad,
        });
        stats[res.status] = (stats[res.status] ?? 0) + 1;
        const body = JSON.stringify(res.body ?? '') + String(res.text ?? '');
        if (res.status >= 500)
          problems.push(
            `${key(r)} -> ${res.status} for ${JSON.stringify(bad).slice(0, 30)}`,
          );
        else if (LEAK.test(body))
          problems.push(`${key(r)} leaked internals: ${body.slice(0, 120)}`);
      }
    }
    return { problems, stats };
  }

  it('anonymous: every route, every payload, distinct client addresses', async () => {
    const { problems, stats } = await fuzz(routes(), () =>
      Promise.resolve(null),
    );
    expect(problems.slice(0, 15)).toEqual([]);
    expect(stats[429] ?? 0).toBe(0); // the rate limiter must not be what protected us
  }, 120_000);

  it('signed-in customer: every non-admin route reaches its handler with hostile input', async () => {
    const list = routes().filter((r) => !r.path.startsWith('/api/v1/admin'));
    const { problems, stats } = await fuzz(list, () => s.session());
    expect(problems.slice(0, 15)).toEqual([]);
    expect(Object.values(stats).reduce((a, b) => a + b, 0)).toBe(
      list.length * NASTY.length,
    );
    expect(stats[429] ?? 0).toBeLessThan(list.length); // a few per-route limits may trip; the bulk must be real answers
  }, 300_000);

  it('privileged admin: every admin handler survives hostile input (the highest-value surface)', async () => {
    const admin = await s.staff('SUPER_ADMIN');
    const list = routes().filter((r) => r.path.startsWith('/api/v1/admin'));
    const { problems, stats } = await fuzz(list, () => Promise.resolve(admin));
    expect(problems.slice(0, 15)).toEqual([]);
    expect(stats[403] ?? 0).toBe(0); // we were really authorised: the handlers ran
  }, 300_000);
});
