import { Logger } from '@nestjs/common';
import autocannon from 'autocannon';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  type TestContext,
} from '../support/test-app.js';

/**
 * Short, real-HTTP load against the real application and database. These are not benchmarks: they prove that under
 * concurrency the service never answers 5xx, abuse controls hold, and stock is never oversold.
 * (Full-length runs against a deployed instance: scripts/load/run.mjs, see docs/ops/load-testing.md.)
 */
let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let base: string;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  await ctx.app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(() => ctx.close());

const rnd = () => randomBytes(4).toString('hex');
const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const codes = (r: autocannon.Result) =>
  Object.fromEntries(
    Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [
      Number(k),
      v.count ?? 0,
    ]),
  ) as Record<number, number>;
const fiveXx = (c: Record<number, number>) =>
  Object.entries(c)
    .filter(([k]) => Number(k) >= 500)
    .reduce((n, [, v]) => n + v, 0);

describe('under concurrent load', () => {
  it('public catalogue search: 20 connections for 4 s, zero 5xx, zero dropped connections', async () => {
    const r = await autocannon({
      url: base,
      connections: 20,
      duration: 4,
      requests: [
        {
          method: 'GET',
          setupRequest: (req) => ({
            ...req,
            path: `/api/v1/catalog/products?q=${rnd()}`,
            headers: { ...req.headers, 'x-forwarded-for': ip() },
          }),
        },
      ],
    });
    const c = codes(r);
    expect(fiveXx(c)).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.timeouts).toBe(0);
    expect(c[200] ?? 0).toBeGreaterThan(100);
  }, 30_000);

  it('credential-guessing flood from ONE address: the cost is bounded by the limiter (Argon2 cannot be used to exhaust the server)', async () => {
    const attacker = ip(); // its own client address: the flood must not eat the shared 127.0.0.1 bucket
    const before = await ctx.prisma.auditLog.count({
      where: { action: 'auth.login.failure' },
    });
    const r = await autocannon({
      url: base,
      connections: 20,
      amount: 300, // a burst of 300 attempts at once
      requests: [
        {
          method: 'POST',
          path: '/api/v1/auth/login',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': attacker,
          },
          setupRequest: (req) => ({
            ...req,
            body: JSON.stringify({
              email: `nobody-${rnd()}@example.com`,
              password: 'definitely-wrong-password',
            }),
          }),
        },
      ],
    });
    const c = codes(r);
    expect(fiveXx(c)).toBe(0);
    expect(r.errors).toBe(0);
    // 30 per 10 minutes per address: everything beyond that is turned away BEFORE any password hashing
    expect(c[401] ?? 0).toBeLessThanOrEqual(30);
    expect(c[429] ?? 0).toBeGreaterThanOrEqual(250);
    // unknown accounts leave no per-user failure trail, so the proof of boundedness is the status split above
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.login.failure' },
      }),
    ).toBeLessThanOrEqual(before + 30);
  }, 60_000);

  it('account-creation flood from one address is limited too, with no 5xx', async () => {
    const attacker = ip();
    const r = await autocannon({
      url: base,
      connections: 10,
      amount: 100,
      requests: [
        {
          method: 'POST',
          path: '/api/v1/auth/register',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': attacker,
          },
          setupRequest: (req) => ({
            ...req,
            body: JSON.stringify({
              firstName: 'Load',
              lastName: 'Test',
              email: `load-${rnd()}@example.com`,
              phone: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
              password: `Tr0ub4dor&3-${rnd()}-horse`,
              newsletter: false,
              acceptPrivacyPolicy: true,
            }),
          }),
        },
      ],
    });
    const c = codes(r);
    expect(fiveXx(c)).toBe(0);
    expect(c[429] ?? 0).toBeGreaterThan(0);
    expect(c[202] ?? 0).toBeLessThan(100); // never all of them
  }, 60_000);
});

describe('stock is never oversold under a rush', () => {
  it('12 customers hit checkout at the same instant for 3 units: exactly 3 orders, 9 refusals, reserved == 3', async () => {
    const { variant } = await shop.fx.product({ priceMinor: 10_000, stock: 3 });
    const buyers = [];
    for (let i = 0; i < 12; i++) {
      const u = await shop.customer();
      await shop.fill(u, [{ variantId: variant.id }]);
      buyers.push(u);
    }
    const results = await Promise.all(buyers.map((u) => shop.place(u)));
    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(9);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 3,
      reserved: 3,
    });
    // every refused customer still has an intact cart and no stray order
    for (const [i, r] of results.entries())
      if (r.status === 409)
        expect(
          await ctx.prisma.order.count({
            where: { userId: buyers[i]!.userId },
          }),
        ).toBe(0);
  }, 90_000);

  it('a double-submit storm on ONE cart (30 parallel identical requests, one key) yields exactly one order', async () => {
    const { variant } = await shop.fx.product({
      priceMinor: 10_000,
      stock: 10,
    });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    const key = `storm-${rnd()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        ctx
          .http()
          .post('/api/v1/checkout/orders')
          .set({ ...authed(u), 'Idempotency-Key': key })
          .send({ addressId: u.addressId }),
      ),
    );
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const ids = new Set(
      results
        .filter((r) => r.status === 201)
        .map((r) => r.body.data.id as string),
    );
    expect(ids.size).toBe(1);
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      1,
    );
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 1 });
  }, 60_000);
});
