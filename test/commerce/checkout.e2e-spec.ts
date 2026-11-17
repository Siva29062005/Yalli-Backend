import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  CatalogFixture,
  Scenario,
  Shop,
  authed,
  createTestApp,
  freshIp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let fx: CatalogFixture;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  fx = shop.fx;
});
afterAll(() => ctx.close());

const coupon = (data: Record<string, unknown> = {}) =>
  ctx.prisma.coupon.create({
    data: {
      code: `C${randomBytes(4).toString('hex').toUpperCase()}`,
      discountType: 'PERCENTAGE',
      percentBps: 1000,
      ...data,
    } as never,
  });

describe('quote', () => {
  it('prices the cart on the server with GST split CGST+SGST within the seller state and IGST outside it', async () => {
    const { variant } = await fx.product({ priceMinor: 59_000, stock: 9 });
    const intra = await shop.customer('Tamil Nadu');
    const inter = await shop.customer('Karnataka');
    await shop.fill(intra, [{ variantId: variant.id, quantity: 2 }]);
    await shop.fill(inter, [{ variantId: variant.id, quantity: 2 }]);
    const a = (
      await ctx
        .http()
        .post('/api/v1/checkout/quote')
        .set(authed(intra))
        .send({ addressId: intra.addressId })
    ).body.data;
    const b = (
      await ctx
        .http()
        .post('/api/v1/checkout/quote')
        .set(authed(inter))
        .send({ addressId: inter.addressId })
    ).body.data;
    expect(a.totals).toMatchObject({
      subtotalMinor: 118_000,
      totalMinor: 118_000,
      gstIncludedMinor: 18_000,
      shippingMinor: 0,
    });
    expect(a.tax).toEqual({
      supply: 'INTRA_STATE',
      cgstMinor: 9_000,
      sgstMinor: 9_000,
      igstMinor: 0,
    });
    expect(b.tax).toEqual({
      supply: 'INTER_STATE',
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 18_000,
    });
    expect(a.purchasable).toBe(true);
  });

  it('flags unavailable lines instead of hiding them, and refuses addresses that are not yours', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id, quantity: 3 }]);
    await ctx.prisma.inventory.updateMany({
      where: { variantId: variant.id },
      data: { onHand: 1 },
    });
    const q = (
      await ctx
        .http()
        .post('/api/v1/checkout/quote')
        .set(authed(u))
        .send({ addressId: u.addressId })
    ).body.data;
    expect(q.purchasable).toBe(false);
    expect(q.problems).toEqual([
      { variantId: variant.id, issue: 'INSUFFICIENT_STOCK' },
    ]);
    const other = await shop.customer();
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/checkout/quote')
          .set(authed(u))
          .send({ addressId: other.addressId })
      ).status,
    ).toBe(404);
  });
});

describe('placing an order', () => {
  it('creates an immutable snapshot, reserves stock, redeems the coupon and empties the cart - atomically', async () => {
    const a = await fx.product({
      name: 'Snapshot Lamp',
      priceMinor: 100_000,
      stock: 5,
    });
    const b = await fx.product({ priceMinor: 50_000, stock: 5 });
    const c = await coupon({ percentBps: 1000, maxRedemptions: 5 });
    const u = await shop.customer();
    await shop.fill(u, [
      { variantId: a.variant.id, quantity: 2 },
      { variantId: b.variant.id, quantity: 1 },
    ]);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/cart/coupon')
          .set({ ...authed(u), 'X-Forwarded-For': freshIp() })
          .send({ code: c.code })
      ).status,
    ).toBe(200);

    const res = await shop.place(u);
    expect(res.status).toBe(201);
    const order = res.body.data;
    expect(order).toMatchObject({
      status: 'INVENTORY_RESERVED',
      totals: {
        subtotalMinor: 250_000,
        discountMinor: 25_000,
        totalMinor: 225_000,
      },
      couponCode: c.code,
    });
    expect(order.orderNumber).toMatch(/^YL\d{2}-\d+$/);
    expect(
      order.items.reduce(
        (n: number, i: { lineTotalMinor: number }) => n + i.lineTotalMinor,
        0,
      ),
    ).toBe(225_000);

    expect(await shop.stock(a.variant.id)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
    expect(await shop.stock(b.variant.id)).toMatchObject({
      onHand: 5,
      reserved: 1,
    });
    expect(
      (await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: c.id } }))
        .redeemedCount,
    ).toBe(1);
    expect(
      (await ctx.http().get('/api/v1/cart').set(authed(u))).body.data.items,
    ).toEqual([]);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { aggregateId: order.id, eventType: 'order.created' },
      }),
    ).toBe(1);
    const db = await shop.dbOrder(order.id);
    expect(db.history.map((h) => h.toStatus)).toEqual([
      'CREATED',
      'INVENTORY_RESERVED',
    ]);
    expect(
      db.items.map((i) => i.gstIncludedMinor + 0).every((g) => g >= 0),
    ).toBe(true);
  });

  it('the order is a SNAPSHOT: later price/name changes never alter it, and the database refuses edits', async () => {
    const { variant, product } = await fx.product({
      name: 'Original Name',
      priceMinor: 40_000,
      stock: 5,
    });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await ctx.prisma.productVariant.update({
      where: { id: variant.id },
      data: { priceMinor: 99_999 },
    });
    await ctx.prisma.product.update({
      where: { id: product.id },
      data: { name: 'Renamed' },
    });
    const view = (await shop.getOrder(u, order.id)).body.data;
    expect(view.items[0]).toMatchObject({
      productName: 'Original Name',
      unitPriceMinor: 40_000,
    });
    expect(view.totals.totalMinor).toBe(40_000);
    await expect(
      ctx.prisma.orderItem.updateMany({
        where: { orderId: order.id },
        data: { unitPriceMinor: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.orderItem.deleteMany({ where: { orderId: order.id } }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.order.deleteMany({ where: { id: order.id } }),
    ).rejects.toThrow();
  });

  it('IDEMPOTENCY: a retried request returns the SAME order and reserves nothing twice', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id, quantity: 2 }]);
    const key = `retry-${randomBytes(6).toString('hex')}`;
    const first = await shop.place(u, {}, key);
    const again = await shop.place(u, {}, key);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      1,
    );
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 2 });
  });

  it('refuses the same key with a different request (422) and a missing/invalid key (400)', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    const key = `reuse-${randomBytes(6).toString('hex')}`;
    expect((await shop.place(u, {}, key)).status).toBe(201);
    expect((await shop.place(u, { expectedTotalMinor: 1 }, key)).status).toBe(
      422,
    );
    const noKey = await ctx
      .http()
      .post('/api/v1/checkout/orders')
      .set(authed(u))
      .send({ addressId: u.addressId });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await shop.place(u, {}, 'short')).status).toBe(400);
  });

  it('concurrent duplicate submissions (double click) create exactly ONE order', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id, quantity: 2 }]);
    const key = `dbl-${randomBytes(6).toString('hex')}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => shop.place(u, {}, key)),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(new Set(ok.map((r) => r.body.data.id)).size).toBe(1);
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      1,
    );
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 2 });
  });

  it('different keys but the same (already emptied) cart cannot create a second order', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    expect((await shop.place(u)).status).toBe(201);
    const second = await shop.place(u);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CART_EMPTY');
  });

  it('PRICE_CHANGED protects the customer from a surprise total', async () => {
    const { variant } = await fx.product({ priceMinor: 10_000, stock: 5 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    await ctx.prisma.productVariant.update({
      where: { id: variant.id },
      data: { priceMinor: 12_000 },
    });
    const res = await shop.place(u, { expectedTotalMinor: 10_000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
    expect((await shop.place(u, { expectedTotalMinor: 12_000 })).status).toBe(
      201,
    );
  });

  it('the client cannot influence prices, totals or discounts (strict body)', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    for (const extra of [
      { totalMinor: 1 },
      { discountMinor: 99_999 },
      { items: [] },
      { couponCode: 'FREE' },
      { shippingMinor: 0 },
    ]) {
      expect((await shop.place(u, extra)).status).toBe(400);
    }
  });

  it('is ALL-OR-NOTHING: no stock for one line => no order, no reservation, coupon unused, cart intact', async () => {
    const plenty = await fx.product({ stock: 5 });
    const scarce = await fx.product({ stock: 5 });
    const c = await coupon({ maxRedemptions: 5 });
    const u = await shop.customer();
    await shop.fill(u, [
      { variantId: plenty.variant.id, quantity: 2 },
      { variantId: scarce.variant.id, quantity: 2 },
    ]);
    await ctx
      .http()
      .post('/api/v1/cart/coupon')
      .set({ ...authed(u), 'X-Forwarded-For': freshIp() })
      .send({ code: c.code });
    await ctx.prisma.inventory.updateMany({
      where: { variantId: scarce.variant.id },
      data: { onHand: 1 },
    }); // someone else bought it
    const res = await shop.place(u);
    expect(res.status).toBe(409);
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
    expect(await shop.stock(plenty.variant.id)).toMatchObject({ reserved: 0 });
    expect(
      (await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: c.id } }))
        .redeemedCount,
    ).toBe(0);
    expect(
      (await ctx.http().get('/api/v1/cart').set(authed(u))).body.data.items,
    ).toHaveLength(2);
  });

  it('a coupon that hit its limit at the last moment aborts the WHOLE checkout (stock is released too)', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const c = await coupon({ maxRedemptions: 1 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id, quantity: 2 }]);
    await ctx
      .http()
      .post('/api/v1/cart/coupon')
      .set({ ...authed(u), 'X-Forwarded-For': freshIp() })
      .send({ code: c.code });
    await ctx.prisma.coupon.update({
      where: { id: c.id },
      data: { redeemedCount: 1 },
    }); // another buyer took the last use
    const res = await shop.place(u);
    expect(res.status).toBe(409);
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 0 });
  });

  it('two customers racing for the LAST unit: exactly one order is created', async () => {
    const { variant } = await fx.product({ stock: 1 });
    const [a, b] = await Promise.all([shop.customer(), shop.customer()]);
    await shop.fill(a, [{ variantId: variant.id }]);
    await shop.fill(b, [{ variantId: variant.id }]);
    const results = await Promise.all([shop.place(a), shop.place(b)]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      201, 409,
    ]);
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 1,
      reserved: 1,
    });
  });

  it('requires authentication and an address of your own', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    const other = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/checkout/orders')
          .set({
            'Idempotency-Key': 'anon-key-12345',
            'X-Forwarded-For': freshIp(),
          })
          .send({ addressId: u.addressId })
      ).status,
    ).toBe(401);
    const stolen = await shop.place({ ...u, addressId: other.addressId });
    expect(stolen.status).toBe(404);
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
  });
});

describe('stock hoarding', () => {
  it('a customer cannot hold more than 3 unpaid orders: the 4th is refused, and paying, cancelling or expiry frees a slot', async () => {
    const { variant } = await fx.product({ priceMinor: 10_000, stock: 50 });
    const u = await shop.customer();
    const orders = [];
    for (let i = 0; i < 3; i++)
      orders.push(await shop.order(u, [{ variantId: variant.id }]));
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 3 });

    await shop.fill(u, [{ variantId: variant.id }]);
    const refused = await shop.place(u);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TOO_MANY_OPEN_ORDERS');
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 3 }); // nothing more was held
    expect(
      (await ctx.http().get('/api/v1/cart').set(authed(u))).body.data.items,
    ).toHaveLength(1); // the cart is intact

    // paying one of them frees a slot
    await shop.paid(u, orders[0]!.id);
    expect((await shop.place(u)).status).toBe(201);
    // ... which is full again; cancelling one frees it
    await shop.fill(u, [{ variantId: variant.id }]);
    expect((await shop.place(u)).status).toBe(409);
    await ctx
      .http()
      .post(`/api/v1/orders/${orders[1]!.id}/cancel`)
      .set(authed(u))
      .send({})
      .expect(200);
    expect((await shop.place(u)).status).toBe(201);
    // an order whose payment window has already passed no longer counts
    await ctx.prisma.order.updateMany({
      where: { id: orders[2]!.id },
      data: { paymentExpiresAt: new Date(Date.now() - 60_000) },
    });
    await shop.fill(u, [{ variantId: variant.id }]);
    expect((await shop.place(u)).status).toBe(201);
  });

  it('parallel checkouts cannot slip past the cap', async () => {
    const { variant } = await fx.product({ priceMinor: 10_000, stock: 50 });
    const u = await shop.customer();
    const results = [];
    for (let round = 0; round < 3; round++) {
      await shop.fill(u, [{ variantId: variant.id }]);
      results.push(
        ...(await Promise.all(Array.from({ length: 5 }, () => shop.place(u)))),
      );
    }
    const created = await ctx.prisma.order.count({
      where: { userId: u.userId, status: { not: 'CANCELLED' } },
    });
    expect(created).toBeLessThanOrEqual(3);
    expect(results.some((r) => r.status === 201)).toBe(true);
  });

  it("other customers are not affected by one customer's open orders", async () => {
    const { variant } = await fx.product({ priceMinor: 10_000, stock: 50 });
    const hoarder = await shop.customer();
    for (let i = 0; i < 3; i++)
      await shop.order(hoarder, [{ variantId: variant.id }]);
    const other = await shop.customer();
    expect((await shop.order(other, [{ variantId: variant.id }])).status).toBe(
      'INVENTORY_RESERVED',
    );
  });
});

describe('ownership of orders (BOLA)', () => {
  it("another customer's order is invisible and untouchable on every route (404)", async () => {
    const { variant } = await fx.product({ stock: 5 });
    const victim = await shop.customer();
    const attacker = await shop.customer();
    const order = await shop.order(victim, [{ variantId: variant.id }]);
    const probes = [
      ctx.http().get(`/api/v1/orders/${order.id}`).set(authed(attacker)),
      ctx
        .http()
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set(authed(attacker))
        .send({}),
      ctx
        .http()
        .post(`/api/v1/orders/${order.id}/payments`)
        .set({ ...authed(attacker), 'Idempotency-Key': 'probe-key-12345' })
        .send({}),
      ctx
        .http()
        .get(`/api/v1/orders/${order.id}/invoice`)
        .set(authed(attacker)),
      ctx
        .http()
        .get(`/api/v1/orders/${order.id}/payment-status`)
        .set(authed(attacker)),
      ctx
        .http()
        .post(`/api/v1/orders/${order.id}/returns`)
        .set(authed(attacker))
        .send({
          orderItemId: '0190a7c0-0000-7000-8000-000000000000',
          quantity: 1,
          reason: 'WRONG_ITEM',
          opened: false,
        }),
    ];
    for (const r of await Promise.all(probes)) expect(r.status).toBe(404);
    expect(
      (await ctx.http().get('/api/v1/orders').set(authed(attacker))).body.data,
    ).toEqual([]);
    expect((await shop.dbOrder(order.id)).status).toBe('INVENTORY_RESERVED');
  });
});

describe('abandoning an unpaid order', () => {
  it('cancelling releases the stock AND the coupon, exactly once', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const c = await coupon({ maxRedemptions: 3 });
    const u = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id, quantity: 2 }]);
    await ctx
      .http()
      .post('/api/v1/cart/coupon')
      .set({ ...authed(u), 'X-Forwarded-For': freshIp() })
      .send({ code: c.code });
    const order = (await shop.place(u)).body.data;
    expect(
      (await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: c.id } }))
        .redeemedCount,
    ).toBe(1);

    for (let i = 0; i < 2; i++)
      expect(
        (
          await ctx
            .http()
            .post(`/api/v1/orders/${order.id}/cancel`)
            .set(authed(u))
            .send({})
        ).status,
      ).toBe(200);
    const db = await shop.dbOrder(order.id);
    expect(db).toMatchObject({ status: 'CANCELLED' });
    expect(db.cancelledAt).not.toBeNull();
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    expect(
      (await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: c.id } }))
        .redeemedCount,
    ).toBe(0);
    expect(
      await ctx.prisma.couponRedemption.count({ where: { couponId: c.id } }),
    ).toBe(0);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { aggregateId: order.id, eventType: 'order.cancelled' },
      }),
    ).toBe(1);
  });

  it('a cancelled order can no longer be paid', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({});
    const res = await shop.initiate(u, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_PAYABLE');
  });
});

describe('payment window expiry (worker)', () => {
  const expire = (orderId: string) =>
    ctx.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentExpiresAt: new Date(Date.now() - 60_000),
        placedAt: new Date(Date.now() - 3_600_000),
      },
    });

  it('cancels an expired unpaid order and frees its stock, after the provider confirms nothing was paid', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id, quantity: 3 }]);
    await shop.startPayment(u, order.id);
    await expire(order.id);
    await ctx.worker.expireUnpaidOrders();
    expect((await shop.dbOrder(order.id)).status).toBe('CANCELLED');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    expect((await shop.dbOrder(order.id)).payments[0]!.status).toBe(
      'CANCELLED',
    );
  });

  it('NEVER cancels an order the provider says was paid: it completes the order instead', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    const init = await shop.startPayment(u, order.id);
    ctx.razorpay.pay(init.providerOrderId, 'captured'); // paid, but our webhook was lost
    await expire(order.id);
    await ctx.prisma.inventoryReservation.updateMany({
      where: { referenceId: order.id },
      data: {
        createdAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await ctx.worker.expireUnpaidOrders();
    expect((await shop.dbOrder(order.id)).status).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
  });

  it('leaves the order ALONE when the provider cannot be asked (fail-safe)', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await shop.startPayment(u, order.id);
    await expire(order.id);
    ctx.razorpay.failNext.push({
      match: '/payments',
      mode: 'timeout-no-effect',
    });
    await ctx.worker.expireUnpaidOrders();
    expect((await shop.dbOrder(order.id)).status).toBe('PAYMENT_PENDING');
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 1 });
  });

  it('cancels an expired order that never started payment', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await expire(order.id);
    await ctx.worker.expireUnpaidOrders();
    expect((await shop.dbOrder(order.id)).status).toBe('CANCELLED');
  });
});
