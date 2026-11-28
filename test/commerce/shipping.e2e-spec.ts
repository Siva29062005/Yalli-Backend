import { Logger } from '@nestjs/common';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  type Session,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let manager: Awaited<ReturnType<Scenario['staff']>>;
/** Delivery fees are prices: creating methods and changing fees needs pricing.update (ADMIN has both permissions). */
let pricer: Awaited<ReturnType<Scenario['staff']>>;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  manager = await s.staff('ORDER_MANAGER');
  pricer = await s.staff('ADMIN');
});
afterAll(() => ctx.close());
// Shipping methods are global configuration: every test starts from "nothing configured".
beforeEach(async () => {
  await ctx.prisma.shippingMethod.deleteMany();
});

type Cust = Session & { addressId: string };
const method = (over: Record<string, unknown> = {}) => ({
  code: 'STANDARD',
  name: 'Standard delivery',
  baseMinor: 6_000,
  freeAboveMinor: 99_900,
  etaMinDays: 3,
  etaMaxDays: 6,
  ...over,
});
const createMethod = (body: Record<string, unknown>, actor: Session = pricer) =>
  ctx
    .http()
    .post('/api/v1/admin/shipping-methods')
    .set(authed(actor))
    .send(body);
const quote = (u: Cust, body: Record<string, unknown> = {}) =>
  ctx
    .http()
    .post('/api/v1/checkout/quote')
    .set(authed(u))
    .send({ addressId: u.addressId, ...body });
const cart = async (priceMinor: number, state = 'Tamil Nadu') => {
  const { variant } = await shop.fx.product({ priceMinor, stock: 20 });
  const u: Cust = await shop.customer(state);
  await shop.fill(u, [{ variantId: variant.id }]);
  return { u, variant };
};
const admin = (orderId: string, path: string, body: Record<string, unknown>) =>
  ctx
    .http()
    .post(`/api/v1/admin/orders/${orderId}/${path}`)
    .set(authed(manager))
    .send(body);
async function shippedOrder(trackingNumber: string) {
  const { variant } = await shop.fx.product({ priceMinor: 120_000, stock: 5 });
  const u: Cust = await shop.customer();
  const order = await shop.order(u, [{ variantId: variant.id }]);
  await shop.paid(u, order.id);
  await admin(order.id, 'fulfilment', { status: 'PROCESSING' }).expect(200);
  const res = await admin(order.id, 'fulfilment', {
    status: 'SHIPPED',
    trackingCarrier: 'DTDC',
    trackingNumber,
  });
  expect(res.status).toBe(200);
  return { u, order };
}

describe('nothing configured', () => {
  it('shipping is free and the order records no method (existing behaviour is preserved)', async () => {
    const { u } = await cart(50_000);
    const q = await quote(u);
    expect(q.status).toBe(200);
    expect(q.body.data.shipping).toMatchObject({ status: 'FREE', options: [] });
    expect(q.body.data.totals.shippingMinor).toBe(0);
    const res = await shop.place(u);
    expect(res.status).toBe(201);
    expect(res.body.data.totals.shippingMinor).toBe(0);
    expect(res.body.data.shippingMethod).toBeNull();
  });
});

describe('admin shipping methods', () => {
  it('a manager with pricing.update creates, lists and updates methods (audited)', async () => {
    const created = await createMethod(method());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      code: 'STANDARD',
      baseMinor: 6000,
    });
    const list = await ctx
      .http()
      .get('/api/v1/admin/shipping-methods')
      .set(authed(pricer));
    expect(list.body.data).toHaveLength(1);
    const upd = await ctx
      .http()
      .patch(`/api/v1/admin/shipping-methods/${created.body.data.id}`)
      .set(authed(pricer))
      .send({ baseMinor: 7_000, isActive: false });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ baseMinor: 7000, isActive: false });
    const audits = await ctx.prisma.auditLog.findMany({
      where: {
        action: { in: ['shipping.method.created', 'shipping.method.updated'] },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('an order manager edits names and delivery times, but fees and switching methods need pricing.update', async () => {
    expect((await createMethod(method(), manager)).status).toBe(403);
    const created = await createMethod(method());
    const id = created.body.data.id as string;
    const patch = (body: Record<string, unknown>) =>
      ctx
        .http()
        .patch(`/api/v1/admin/shipping-methods/${id}`)
        .set(authed(manager))
        .send(body);
    // the console sends every field: unchanged fees are not a price change
    const ok = await patch({
      name: 'Standard (renamed)',
      etaMaxDays: 7,
      baseMinor: 6_000,
      freeAboveMinor: 99_900,
      isActive: true,
    });
    expect(ok.status).toBe(200);
    for (const body of [
      { baseMinor: 1 },
      { freeAboveMinor: null },
      { isActive: false }, // with no method on, delivery is free
    ])
      expect((await patch(body)).status).toBe(403);
    expect(
      await ctx.prisma.shippingMethod.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      name: 'Standard (renamed)',
      baseMinor: 6_000,
      freeAboveMinor: 99_900,
      isActive: true,
    });
  });

  it('rejects duplicates, unknown fields, bad codes, negative money and inverted ETAs', async () => {
    await createMethod(method()).expect(201);
    expect((await createMethod(method())).body.error.code).toBe(
      'SHIPPING_METHOD_EXISTS',
    );
    expect(
      (await createMethod(method({ code: 'X2', isAdmin: true }))).status,
    ).toBe(400);
    expect((await createMethod(method({ code: 'bad code' }))).status).toBe(400);
    expect(
      (await createMethod(method({ code: 'NEG', baseMinor: -1 }))).status,
    ).toBe(400);
    expect(
      (await createMethod(method({ code: 'FLT', baseMinor: 10.5 }))).status,
    ).toBe(400);
    expect(
      (
        await createMethod(
          method({ code: 'ETA', etaMinDays: 9, etaMaxDays: 2 }),
        )
      ).status,
    ).toBe(409);
  });

  it('is closed to customers, anonymous callers and roles without shipments.manage', async () => {
    const c = await shop.customer();
    expect((await createMethod(method(), c)).status).toBe(403);
    expect(
      (await ctx.http().post('/api/v1/admin/shipping-methods').send(method()))
        .status,
    ).toBe(401);
    const support = await s.staff('CUSTOMER_SUPPORT');
    expect((await createMethod(method(), support)).status).toBe(403);
    expect(await ctx.prisma.shippingMethod.count()).toBe(0);
  });
});

describe('server-side delivery fee', () => {
  beforeEach(async () => {
    await createMethod(method()).expect(201);
    await createMethod(
      method({
        code: 'EXPRESS',
        name: 'Express',
        baseMinor: 15_000,
        freeAboveMinor: null,
        etaMinDays: 1,
        etaMaxDays: 2,
      }),
    ).expect(201);
  });

  it('quote lists options cheapest first and previews the cheapest', async () => {
    const { u } = await cart(50_000);
    const q = await quote(u);
    expect(q.body.data.shipping.status).toBe('SELECTED');
    expect(
      q.body.data.shipping.options.map((o: { code: string }) => o.code),
    ).toEqual(['STANDARD', 'EXPRESS']);
    expect(q.body.data.totals).toMatchObject({
      shippingMinor: 6_000,
      totalMinor: 56_000,
    });
    const ex = await quote(u, { shippingMethodCode: 'EXPRESS' });
    expect(ex.body.data.totals).toMatchObject({
      shippingMinor: 15_000,
      totalMinor: 65_000,
    });
  });

  it('an order needs an explicit choice when there is more than one option', async () => {
    const { u } = await cart(50_000);
    const res = await shop.place(u);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIPPING_METHOD_REQUIRED');
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
  });

  it('charges the fee, snapshots the method and the payment is for the full amount', async () => {
    const { u } = await cart(50_000);
    const res = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    expect(res.status).toBe(201);
    expect(res.body.data.totals).toMatchObject({
      subtotalMinor: 50_000,
      shippingMinor: 6_000,
      totalMinor: 56_000,
    });
    expect(res.body.data.shippingMethod).toEqual({
      code: 'STANDARD',
      name: 'Standard delivery',
    });
    const db = await shop.dbOrder(res.body.data.id);
    expect(db).toMatchObject({
      shippingMinor: 6_000,
      shippingMethodCode: 'STANDARD',
    });
    const pay = await shop.startPayment(u, db.id);
    expect(pay.amountMinor).toBe(56_000);
  });

  it('a later change to the method does not touch an existing order (snapshot)', async () => {
    const { u } = await cart(50_000);
    const res = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    await ctx.prisma.shippingMethod.updateMany({
      data: { baseMinor: 99_000, name: 'Renamed' },
    });
    const db = await shop.dbOrder(res.body.data.id);
    expect(db).toMatchObject({
      shippingMinor: 6_000,
      shippingMethodName: 'Standard delivery',
    });
  });

  it('is free once the discounted items total reaches the threshold', async () => {
    const { u } = await cart(99_900);
    const res = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    expect(res.body.data.totals).toMatchObject({
      shippingMinor: 0,
      totalMinor: 99_900,
    });
    expect(res.body.data.shippingMethod.code).toBe('STANDARD');
  });

  it('the threshold uses the total AFTER the coupon discount', async () => {
    const { variant } = await shop.fx.product({
      priceMinor: 100_000,
      stock: 5,
    });
    await ctx.prisma.coupon.create({
      data: {
        code: `SHIPCUT${Date.now()}`,
        discountType: 'FIXED_AMOUNT',
        amountMinor: 10_000,
        scope: 'ALL_ITEMS',
      },
    });
    const coupon = await ctx.prisma.coupon.findFirstOrThrow({
      where: { code: { startsWith: 'SHIPCUT' } },
    });
    const u: Cust = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id }]);
    await ctx
      .http()
      .post('/api/v1/cart/coupon')
      .set(authed(u))
      .send({ code: coupon.code })
      .expect(200);
    const res = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    // 100000 - 10000 = 90000 < 99900, so the fee applies
    expect(res.body.data.totals).toMatchObject({
      discountMinor: 10_000,
      shippingMinor: 6_000,
      totalMinor: 96_000,
    });
  });

  it('refuses a method that is not offered, and an unknown code, without creating an order', async () => {
    await createMethod(
      method({ code: 'LOCAL', baseMinor: 2_000, states: ['Tamil Nadu'] }),
    ).expect(201);
    const { u } = await cart(50_000, 'Kerala');
    const q = await quote(u);
    expect(
      q.body.data.shipping.options.map((o: { code: string }) => o.code),
    ).not.toContain('LOCAL');
    const bad = await shop.place(u, { shippingMethodCode: 'LOCAL' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('SHIPPING_METHOD_INVALID');
    const unknown = await shop.place(u, { shippingMethodCode: 'NOPE' });
    expect(unknown.body.error.code).toBe('SHIPPING_METHOD_INVALID');
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
  });

  it('blocks checkout when no active method serves the address', async () => {
    await ctx.prisma.shippingMethod.deleteMany();
    await createMethod(
      method({ code: 'TNONLY', states: ['Tamil Nadu'] }),
    ).expect(201);
    const { u } = await cart(50_000, 'Kerala');
    const q = await quote(u);
    expect(q.body.data.shipping.status).toBe('UNAVAILABLE');
    expect(q.body.data.purchasable).toBe(false);
    const res = await shop.place(u);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIPPING_UNAVAILABLE');
  });

  it('inactive methods are never offered', async () => {
    await ctx.prisma.shippingMethod.updateMany({
      where: { code: 'EXPRESS' },
      data: { isActive: false },
    });
    const { u } = await cart(50_000);
    const q = await quote(u);
    expect(q.body.data.shipping.options).toHaveLength(1);
    const res = await shop.place(u); // a single option is applied automatically
    expect(res.status).toBe(201);
    expect(res.body.data.shippingMethod.code).toBe('STANDARD');
  });

  it('a client cannot set the fee, and a stale expected total is caught', async () => {
    const { u } = await cart(50_000);
    const cheat = await shop.place(u, {
      shippingMethodCode: 'STANDARD',
      shippingMinor: 0,
    });
    expect(cheat.status).toBe(400);
    const stale = await shop.place(u, {
      shippingMethodCode: 'EXPRESS',
      expectedTotalMinor: 56_000, // the STANDARD total
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
  });

  it('cancelling a paid order refunds the delivery fee too', async () => {
    const { u } = await cart(50_000);
    const res = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    const { payment } = await shop.paid(u, res.body.data.id);
    const c = await ctx
      .http()
      .post(`/api/v1/orders/${res.body.data.id}/cancel`)
      .set(authed(u))
      .send({});
    expect(c.status).toBe(200);
    expect(ctx.razorpay.payments.get(payment.id)!.amount_refunded).toBe(56_000);
  });

  it('the database refuses a delivery fee with no recorded method', async () => {
    const { u } = await cart(50_000);
    const res = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    await expect(
      ctx.prisma
        .$executeRaw`UPDATE orders SET shipping_method_code = NULL, shipping_method_name = NULL WHERE id = ${res.body.data.id}::uuid`,
    ).rejects.toThrow();
  });
});

describe('shipments and tracking', () => {
  it('marking an order shipped creates the shipment and the customer can track it', async () => {
    const { u, order } = await shippedOrder('DT-TRK-1001');
    const res = await ctx
      .http()
      .get(`/api/v1/orders/${order.id}/tracking`)
      .set(authed(u));
    expect(res.status).toBe(200);
    expect(res.body.data.shipment).toMatchObject({
      carrier: 'DTDC',
      trackingNumber: 'DT-TRK-1001',
      status: 'IN_TRANSIT',
    });
    expect(res.body.data.shipment.events).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('actorId');
  });

  it('an unshipped order has no shipment yet', async () => {
    const { variant } = await shop.fx.product({ priceMinor: 10_000, stock: 5 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    const res = await ctx
      .http()
      .get(`/api/v1/orders/${order.id}/tracking`)
      .set(authed(u));
    expect(res.status).toBe(200);
    expect(res.body.data.shipment).toBeNull();
  });

  it("another customer's order is a 404, and anonymous callers get 401", async () => {
    const { order } = await shippedOrder('DT-TRK-1002');
    const other = await shop.customer();
    expect(
      (
        await ctx
          .http()
          .get(`/api/v1/orders/${order.id}/tracking`)
          .set(authed(other))
      ).status,
    ).toBe(404);
    expect(
      (await ctx.http().get(`/api/v1/orders/${order.id}/tracking`)).status,
    ).toBe(401);
  });

  it('tracking moves forward; DELIVERED completes the order; repeats are idempotent; going back is refused', async () => {
    const { u, order } = await shippedOrder('DT-TRK-1003');
    const out = await admin(order.id, 'tracking', {
      status: 'OUT_FOR_DELIVERY',
      location: 'Madurai hub',
    });
    expect(out.status).toBe(200);
    expect(out.body.data.shipment.status).toBe('OUT_FOR_DELIVERY');

    const back = await admin(order.id, 'tracking', { status: 'IN_TRANSIT' });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('INVALID_SHIPMENT_TRANSITION');

    const done = await admin(order.id, 'tracking', {
      status: 'DELIVERED',
      note: 'Left with security',
    });
    expect(done.status).toBe(200);
    expect(done.body.data.shipment).toMatchObject({ status: 'DELIVERED' });
    const db = await shop.dbOrder(order.id);
    expect(db.status).toBe('DELIVERED');
    expect(db.deliveredAt).not.toBeNull();

    const again = await admin(order.id, 'tracking', { status: 'DELIVERED' });
    expect(again.status).toBe(200);
    const events = await ctx.prisma.shipmentEvent.count({
      where: { shipment: { orderId: order.id } },
    });
    expect(events).toBe(3); // IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED - the repeat added nothing

    const leave = await admin(order.id, 'tracking', {
      status: 'OUT_FOR_DELIVERY',
    });
    expect(leave.status).toBe(409);
    const view = await ctx
      .http()
      .get(`/api/v1/orders/${order.id}/tracking`)
      .set(authed(u));
    expect(
      view.body.data.shipment.events.map((e: { status: string }) => e.status),
    ).toEqual(['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT']);
  });

  it('marking delivered through the fulfilment endpoint also closes the shipment', async () => {
    const { order } = await shippedOrder('DT-TRK-1004');
    await admin(order.id, 'fulfilment', { status: 'DELIVERED' }).expect(200);
    const sh = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(sh.status).toBe('DELIVERED');
    expect(sh.deliveredAt).not.toBeNull();
  });

  it('refuses tracking for an order that has not shipped, and a future timestamp', async () => {
    const { variant } = await shop.fx.product({ priceMinor: 10_000, stock: 5 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    const early = await admin(order.id, 'tracking', { status: 'IN_TRANSIT' });
    expect(early.status).toBe(409);
    const shipped = await shippedOrder('DT-TRK-1005');
    const future = await admin(shipped.order.id, 'tracking', {
      status: 'OUT_FOR_DELIVERY',
      occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(future.status).toBe(409);
  });

  it('refuses a tracking time before the shipment or before its latest update (no backdated delivery)', async () => {
    const { order } = await shippedOrder('DT-TRK-1016');
    const sh = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    const beforeShipping = await admin(order.id, 'tracking', {
      status: 'DELIVERED',
      occurredAt: new Date(sh.shippedAt.getTime() - 86_400_000).toISOString(),
    });
    expect(beforeShipping.status).toBe(409);
    const out = await admin(order.id, 'tracking', {
      status: 'OUT_FOR_DELIVERY',
    });
    expect(out.status).toBe(200);
    const beforeLatest = await admin(order.id, 'tracking', {
      status: 'DELIVERED',
      occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(), // after shipping, before "out for delivery"
    });
    expect(beforeLatest.status).toBe(409);
    expect((await shop.dbOrder(order.id)).deliveredAt).toBeNull();
    expect(
      (await admin(order.id, 'tracking', { status: 'DELIVERED' })).status,
    ).toBe(200);
  });

  it('a tracking number can belong to one shipment only', async () => {
    await shippedOrder('DT-TRK-1006');
    const { variant } = await shop.fx.product({
      priceMinor: 120_000,
      stock: 5,
    });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await shop.paid(u, order.id);
    await admin(order.id, 'fulfilment', { status: 'PROCESSING' }).expect(200);
    const dup = await admin(order.id, 'fulfilment', {
      status: 'SHIPPED',
      trackingCarrier: 'DTDC',
      trackingNumber: 'DT-TRK-1006',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TRACKING_NUMBER_IN_USE');
    expect((await shop.dbOrder(order.id)).status).toBe('PROCESSING'); // nothing half-applied
  });

  it('tracking updates need shipments.manage', async () => {
    const { u, order } = await shippedOrder('DT-TRK-1007');
    const support = await s.staff('CUSTOMER_SUPPORT');
    const body = { status: 'OUT_FOR_DELIVERY' };
    for (const actor of [u, support])
      expect(
        (
          await ctx
            .http()
            .post(`/api/v1/admin/orders/${order.id}/tracking`)
            .set(authed(actor))
            .send(body)
        ).status,
      ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/orders/${order.id}/tracking`)
          .send(body)
      ).status,
    ).toBe(401);
    expect(
      (
        await admin(order.id, 'tracking', {
          status: 'OUT_FOR_DELIVERY',
          carrier: 'x',
        })
      ).status,
    ).toBe(400);
  });

  it('tracking history is append-only at the database level', async () => {
    const { order } = await shippedOrder('DT-TRK-1008');
    await expect(
      ctx.prisma
        .$executeRaw`UPDATE shipment_events SET note = 'edited' WHERE shipment_id IN (SELECT id FROM shipments WHERE order_id = ${order.id}::uuid)`,
    ).rejects.toThrow();
    await expect(
      ctx.prisma
        .$executeRaw`DELETE FROM shipment_events WHERE shipment_id IN (SELECT id FROM shipments WHERE order_id = ${order.id}::uuid)`,
    ).rejects.toThrow();
  });
});
