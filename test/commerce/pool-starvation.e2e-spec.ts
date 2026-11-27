import { Logger } from '@nestjs/common';
import { vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  type Session,
  type TestContext,
} from '../support/test-app.js';

// A deliberately TINY connection pool. A transaction holds one connection; if code inside it asks the shared client for a
// second one, then (number of concurrent transactions) >= (pool size) leaves every connection held by a transaction that is
// waiting for another: they all stall until the transaction timeout and fail. Production has the same shape at pool size 10.
// With a pool of 3, any such nesting shows up here at once. Every transactional flow below runs with 3x the pool size
// in parallel and must answer without a single 5xx.
// (vi.hoisted runs BEFORE the imports below; the application reads its configuration while its modules are evaluated)
vi.hoisted(() => {
  process.env['DATABASE_POOL_MAX'] = '3';
});

let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let ops: Awaited<ReturnType<Scenario['staff']>>;
let finance: Awaited<ReturnType<Scenario['staff']>>;
let support: Awaited<ReturnType<Scenario['staff']>>;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  ops = await s.staff('ORDER_MANAGER');
  finance = await s.staff('FINANCE_MANAGER');
  support = await s.staff('CUSTOMER_SUPPORT');
});
afterAll(() => ctx.close());

const N = 9; // three times the pool
type Cust = Session & { addressId: string };
const no5xx = (rs: { status: number }[], label: string) => {
  const bad = rs.filter((r) => r.status >= 500).map((r) => r.status);
  expect(bad, `${label}: ${bad.length} server errors`).toEqual([]);
};
async function customers(n: number, variantId: string): Promise<Cust[]> {
  const out: Cust[] = [];
  for (let i = 0; i < n; i++) {
    const u = await shop.customer();
    await shop.fill(u, [{ variantId }]);
    out.push(u);
  }
  return out;
}

describe('no flow needs a second connection while it holds one', () => {
  it('checkout (with a coupon and a delivery method): 9 in parallel', async () => {
    await ctx.prisma.shippingMethod.create({
      data: {
        code: 'POOL',
        name: 'Pool test',
        baseMinor: 5_000,
        etaMinDays: 1,
        etaMaxDays: 2,
        states: [],
      },
    });
    const code = `POOL${randomBytes(3).toString('hex').toUpperCase()}`;
    await ctx.prisma.coupon.create({
      data: {
        code,
        discountType: 'FIXED_AMOUNT',
        amountMinor: 1_000,
        scope: 'ALL_ITEMS',
      },
    });
    const { variant } = await shop.fx.product({
      priceMinor: 50_000,
      stock: 100,
    });
    const us = await customers(N, variant.id);
    for (const u of us)
      await ctx
        .http()
        .post('/api/v1/cart/coupon')
        .set(authed(u))
        .send({ code })
        .expect(200);
    const rs = await Promise.all(
      us.map((u) => shop.place(u, { shippingMethodCode: 'POOL' })),
    );
    no5xx(rs, 'checkout');
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: N });
    await ctx.prisma.shippingMethod.deleteMany();
  }, 120_000);

  it('payment capture webhooks, browser confirmations and payment status: 9 in parallel', async () => {
    const { variant } = await shop.fx.product({
      priceMinor: 40_000,
      stock: 100,
    });
    const us = await customers(N, variant.id);
    const orders = [];
    for (const u of us)
      orders.push({ u, order: (await shop.place(u)).body.data });
    const inits = await Promise.all(
      orders.map(({ u, order }) => shop.startPayment(u, order.id)),
    );
    const hooks = inits.map((i) =>
      ctx.razorpay.paymentWebhook(
        'payment.captured',
        ctx.razorpay.pay(i.providerOrderId, 'captured'),
      ),
    );
    const rs = await Promise.all(hooks.map((h) => shop.webhook(h)));
    no5xx(rs, 'webhooks');
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const status = await Promise.all(
      orders.map(({ u, order }) =>
        ctx
          .http()
          .get(`/api/v1/orders/${order.id}/payment-status`)
          .set(authed(u)),
      ),
    );
    no5xx(status, 'payment-status');
    for (const { order } of orders)
      expect((await shop.dbOrder(order.id)).status).toBe('PAID');
  }, 120_000);

  it('late captures on cancelled orders and amount mismatches (audited in the transaction): 9 in parallel each', async () => {
    const { variant } = await shop.fx.product({
      priceMinor: 40_000,
      stock: 100,
    });
    const us = await customers(2 * N, variant.id);
    const orders = [];
    for (const u of us)
      orders.push({ u, order: (await shop.place(u)).body.data });
    const inits = [];
    for (const { u, order } of orders)
      inits.push(await shop.startPayment(u, order.id));
    // First half: the customer cancels, THEN the payment arrives (late capture -> automatic refund).
    for (const { u, order } of orders.slice(0, N))
      await ctx
        .http()
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set(authed(u))
        .send({})
        .expect(200);
    const late = inits
      .slice(0, N)
      .map((i) =>
        ctx.razorpay.paymentWebhook(
          'payment.captured',
          ctx.razorpay.pay(i.providerOrderId, 'captured'),
        ),
      );
    // Second half: the provider reports a different amount (mismatch -> never paid, audited).
    const odd = inits
      .slice(N)
      .map((i) =>
        ctx.razorpay.paymentWebhook(
          'payment.captured',
          ctx.razorpay.pay(i.providerOrderId, 'captured', { amount: 1_000 }),
        ),
      );
    const rs = await Promise.all([...late, ...odd].map((h) => shop.webhook(h)));
    no5xx(rs, 'late captures and mismatches');
    for (const { order } of orders.slice(0, N))
      expect((await shop.dbOrder(order.id)).status).toBe('CANCELLED');
    for (const { order } of orders.slice(N))
      expect((await shop.dbOrder(order.id)).status).not.toBe('PAID');
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          action: { in: ['payment.captured', 'payment.amount_mismatch'] },
          resourceId: {
            in: (
              await ctx.prisma.payment.findMany({
                where: { orderId: { in: orders.map((o) => o.order.id) } },
                select: { id: true },
              })
            ).map((p) => p.id),
          },
        },
      }),
    ).toBeGreaterThanOrEqual(2 * N);
  }, 180_000);

  it('fulfilment, tracking, cancel-after-payment and refunds: 9 in parallel each', async () => {
    const { variant } = await shop.fx.product({
      priceMinor: 40_000,
      stock: 100,
    });
    const us = await customers(N * 2, variant.id);
    const paid = [];
    for (const u of us) {
      const order = (await shop.place(u)).body.data;
      await shop.paid(u, order.id);
      paid.push({ u, order });
    }
    const toShip = paid.slice(0, N);
    const toCancel = paid.slice(N);
    const adm = (id: string, path: string, body: object) =>
      ctx
        .http()
        .post(`/api/v1/admin/orders/${id}/${path}`)
        .set(authed(ops))
        .send(body);

    no5xx(
      await Promise.all(
        toShip.map(({ order }) =>
          adm(order.id, 'fulfilment', { status: 'PROCESSING' }),
        ),
      ),
      'processing',
    );
    no5xx(
      await Promise.all(
        toShip.map(({ order }) =>
          adm(order.id, 'fulfilment', {
            status: 'SHIPPED',
            trackingCarrier: 'DTDC',
            trackingNumber: `T${randomBytes(6).toString('hex')}`,
          }),
        ),
      ),
      'shipped',
    );
    no5xx(
      await Promise.all(
        toShip.map(({ order }) =>
          adm(order.id, 'tracking', { status: 'OUT_FOR_DELIVERY' }),
        ),
      ),
      'tracking',
    );
    no5xx(
      await Promise.all(
        toShip.map(({ order }) =>
          adm(order.id, 'tracking', { status: 'DELIVERED' }),
        ),
      ),
      'delivered',
    );

    const cancels = await Promise.all(
      toCancel.map(({ u, order }) =>
        ctx
          .http()
          .post(`/api/v1/orders/${order.id}/cancel`)
          .set(authed(u))
          .send({}),
      ),
    );
    no5xx(cancels, 'cancel after payment');
    for (const { order } of toCancel)
      expect((await shop.dbOrder(order.id)).status).toBe('REFUNDED');

    // returns, then human refunds, on the delivered orders
    const asks = await Promise.all(
      toShip.map(async ({ u, order }) => {
        const item = (await shop.dbOrder(order.id)).items[0]!;
        return ctx
          .http()
          .post(`/api/v1/orders/${order.id}/returns`)
          .set(authed(u))
          .send({
            orderItemId: item.id,
            quantity: 1,
            reason: 'CHANGED_MIND',
            opened: false,
          });
      }),
    );
    no5xx(asks, 'return requests');
    const refundReqs = await Promise.all(
      toShip.map(({ order }, i) =>
        ctx
          .http()
          .post('/api/v1/admin/refunds')
          .set({
            ...authed(support),
            'Idempotency-Key': `pool-${i}-${randomBytes(4).toString('hex')}`,
          })
          .send({
            orderId: order.id,
            amountMinor: 1_000,
            reason: 'Goodwill credit',
          }),
      ),
    );
    no5xx(refundReqs, 'refund requests');
    const approvals = await Promise.all(
      refundReqs
        .filter((r) => r.status === 201)
        .map((r) =>
          ctx
            .http()
            .post(`/api/v1/admin/refunds/${r.body.data.id}/approve`)
            .set(authed(finance))
            .send({}),
        ),
    );
    no5xx(approvals, 'refund approvals');
  }, 240_000);

  it('Phase 11 console flows: failed-refund retries and image reorders, 9 in parallel each', async () => {
    // refunds the provider refuses -> FAILED, then 9 retries at once (each locks the order, then the payment)
    const failed: string[] = [];
    for (let i = 0; i < N; i++) {
      const { variant } = await shop.fx.product({
        priceMinor: 20_000,
        stock: 5,
      });
      const [u] = await customers(1, variant.id);
      const order = await shop.order(u!, [{ variantId: variant.id }]);
      await shop.paid(u!, order.id);
      ctx.razorpay.failNext.push({ match: '/refund', mode: 'reject' });
      await ctx
        .http()
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set(authed(u!))
        .send({})
        .expect(200);
      failed.push((await shop.dbOrder(order.id)).refunds[0]!.id);
    }
    const retries = await Promise.all(
      failed.map((id, i) =>
        ctx
          .http()
          .post(`/api/v1/admin/refunds/${id}/retry`)
          .set({
            ...authed(support),
            'Idempotency-Key': `pool-retry-${i}-${randomBytes(4).toString('hex')}`,
          }),
      ),
    );
    no5xx(retries, 'refund retries');
    expect(retries.every((r) => r.status === 201)).toBe(true);

    // 9 image moves on one product at once (each renumbers the gallery in one transaction)
    const pm = await s.staff('PRODUCT_MANAGER');
    const { product } = await shop.fx.product();
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
      'hex',
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          await ctx
            .http()
            .post(`/api/v1/admin/products/${product.id}/images`)
            .set(authed(pm))
            .attach('file', png, {
              filename: 'p.png',
              contentType: 'image/png',
            })
            .expect(201)
        ).body.data.id,
      );
    const moves = await Promise.all(
      Array.from(
        { length: N },
        (_, i) =>
          ctx
            .http()
            .patch(`/api/v1/admin/images/${ids[i % 3]}`)
            .set(authed(pm))
            .send({ position: (i * 2) % 3, altText: `View ${i}` }), // field + move: the case that could deadlock
      ),
    );
    no5xx(moves, 'image moves');
    const positions = (
      await ctx.prisma.productImage.findMany({
        where: { productId: product.id },
        select: { position: true },
      })
    )
      .map((r) => r.position)
      .sort();
    expect(positions).toEqual([0, 1, 2]); // still a clean sequence after the concurrent moves
  }, 240_000);

  it('reviews, wishlist and catalogue reads: 9 in parallel', async () => {
    const { product } = await shop.fx.product({
      priceMinor: 10_000,
      stock: 50,
    });
    const us = await Promise.all(
      Array.from({ length: N }, () => shop.customer()),
    );
    no5xx(
      await Promise.all(
        us.map((u) =>
          ctx.http().put(`/api/v1/me/wishlist/${product.slug}`).set(authed(u)),
        ),
      ),
      'wishlist',
    );
    no5xx(
      await Promise.all(
        us.map((u) => ctx.http().get('/api/v1/me/wishlist').set(authed(u))),
      ),
      'wishlist list',
    );
    no5xx(
      await Promise.all(
        us.map(() =>
          ctx.http().get(`/api/v1/catalog/products/${product.slug}`),
        ),
      ),
      'product',
    );
    no5xx(
      await Promise.all(
        us.map(() => ctx.http().get('/api/v1/catalog/categories')),
      ),
      'categories',
    );
  }, 120_000);
});
