import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  waitFor,
  type Session,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let shop: Shop;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
});
afterAll(() => ctx.close());

type Cust = Session & { addressId: string };
/** A PAID order (price x quantity) ready for refund scenarios. */
async function paidOrder(priceMinor = 100_000, quantity = 1, stock = 10) {
  const { variant } = await shop.fx.product({ priceMinor, stock });
  const u: Cust = await shop.customer();
  const order = await shop.order(u, [{ variantId: variant.id, quantity }]);
  const { payment } = await shop.paid(u, order.id);
  return { u, order, variant, payment, total: priceMinor * quantity };
}
const idem = () => `r-${randomBytes(8).toString('hex')}`;
const requestRefund = (
  actor: Session,
  body: Record<string, unknown>,
  key = idem(),
) =>
  ctx
    .http()
    .post('/api/v1/admin/refunds')
    .set({ ...authed(actor), 'Idempotency-Key': key })
    .send(body);
const approve = (actor: Session, id: string) =>
  ctx
    .http()
    .post(`/api/v1/admin/refunds/${id}/approve`)
    .set(authed(actor))
    .send({});
const refunded = (providerPaymentId: string) =>
  ctx.razorpay.payments.get(providerPaymentId)!.amount_refunded;
const payOf = async (orderId: string) =>
  (await shop.dbOrder(orderId)).payments[0]!;

describe('cancelling a PAID order whose refund is rejected by the provider', () => {
  it('credits stock exactly once, never returns the order to a shippable state, and finance can finish it', async () => {
    const { u, order, variant, payment, total } = await paidOrder(100_000, 2);
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 8 });

    ctx.razorpay.failNext.push({ match: '/refund', mode: 'reject' });
    const first = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({});
    expect(first.status).toBe(200);
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 10 }); // goods are back, once
    const refund = (await shop.dbOrder(order.id)).refunds[0]!;
    expect(refund.status).toBe('FAILED');
    // the order did NOT revert to PAID (it would ship goods that are already counted back in stock)
    expect((await shop.dbOrder(order.id)).status).toBe('REFUND_PENDING');

    // repeating the cancel must neither restock again nor change anything
    for (let i = 0; i < 3; i++) {
      const again = await ctx
        .http()
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set(authed(u))
        .send({});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    }
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 10 });
    expect(
      await ctx.prisma.inventoryMovement.count({
        where: { variantId: variant.id, type: 'RETURN' },
      }),
    ).toBe(1);

    // finance completes it by hand (four-eyes), and the order ends REFUNDED without touching stock again
    const support = await s.staff('CUSTOMER_SUPPORT');
    const finance = await s.staff('FINANCE_MANAGER');
    const req = await requestRefund(support, {
      orderId: order.id,
      amountMinor: total,
      reason: 'Provider rejected the automatic refund',
    });
    expect(req.status).toBe(201);
    expect((await approve(finance, req.body.data.id)).status).toBe(200);
    expect(refunded(payment.id)).toBe(total);
    expect((await shop.dbOrder(order.id)).status).toBe('REFUNDED');
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 10 });
  });
});

describe('customer cancels a PAID order', () => {
  it('stock goes back on the shelf, the FULL amount is refunded automatically, and the order ends REFUNDED', async () => {
    const { u, order, variant, payment, total } = await paidOrder(59_000, 2);
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 8 });
    const res = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({ reason: 'Ordered by mistake' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REFUNDED');

    expect(refunded(payment.id)).toBe(total);
    const db = await shop.dbOrder(order.id);
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({
      kind: 'CUSTOMER_CANCEL',
      status: 'PROCESSED',
      amountMinor: total,
      requestedById: null,
    });
    expect(db.payments[0]).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: total,
    });
    expect(db.cancelledAt).not.toBeNull();
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 10,
      reserved: 0,
    });
    expect(db.history.map((h) => h.toStatus)).toEqual([
      'CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_PENDING',
      'PAID',
      'REFUND_PENDING',
      'REFUNDED',
    ]);
    await ctx.drainOutbox();
    expect(ctx.notifier.last('REFUND_PROCESSED', u.email)).toMatchObject({
      amountMinor: total,
    });
  });

  it('is idempotent: cancelling again neither refunds twice nor restocks twice', async () => {
    const { u, order, variant, payment, total } = await paidOrder(30_000);
    for (let i = 0; i < 3; i++)
      await ctx
        .http()
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set(authed(u))
        .send({});
    expect(refunded(payment.id)).toBe(total);
    expect(
      await ctx.prisma.refund.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 10 });
  });

  it('parallel cancel requests refund exactly once', async () => {
    const { u, order, variant, payment, total } = await paidOrder(30_000);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx
          .http()
          .post(`/api/v1/orders/${order.id}/cancel`)
          .set(authed(u))
          .send({}),
      ),
    );
    expect(refunded(payment.id)).toBe(total);
    expect(
      await ctx.prisma.refund.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 10 });
  });

  it('a SHIPPED order cannot be cancelled', async () => {
    const { u, order } = await paidOrder();
    const om = await s.staff('ORDER_MANAGER');
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
      .set(authed(om))
      .send({ status: 'PROCESSING' })
      .expect(200);
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
      .set(authed(om))
      .send({
        status: 'SHIPPED',
        trackingCarrier: 'DTDC',
        trackingNumber: 'DT123456',
      })
      .expect(200);
    const res = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    expect(
      await ctx.prisma.refund.count({ where: { orderId: order.id } }),
    ).toBe(0);
  });
});

describe('staff cancels a PAID order: the refund needs a second approver', () => {
  const staffCancel = (actor: Session, orderId: string) =>
    ctx
      .http()
      .post(`/api/v1/admin/orders/${orderId}/cancel`)
      .set(authed(actor))
      .send({ reason: 'Customer phoned to cancel' });

  it('an ORDER_MANAGER cancel only REQUESTS it: a PENDING refund in their name, nothing moves until finance approves', async () => {
    const { order, variant, payment, total } = await paidOrder(59_000, 2);
    const om = await s.staff('ORDER_MANAGER');
    const stockBefore = await shop.stock(variant.id);
    const res = await staffCancel(om, order.id);
    expect(res.status).toBe(200);
    let db = await shop.dbOrder(order.id);
    expect(db.status).toBe('REFUND_PENDING');
    expect(db.cancelledAt).toBeNull(); // not cancelled yet
    expect(await shop.stock(variant.id)).toEqual(stockBefore); // nothing restocked yet
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({
      kind: 'ADMIN',
      status: 'PENDING_APPROVAL',
      amountMinor: total,
      requestedById: om.userId,
    });
    expect(refunded(payment.id)).toBe(0); // nothing sent to the provider

    // The canceller cannot approve their own refund (no permission, and four-eyes).
    expect((await approve(om, db.refunds[0]!.id)).status).toBe(403);
    const finance = await s.staff('FINANCE_MANAGER');
    expect((await approve(finance, db.refunds[0]!.id)).status).toBe(200);
    expect(refunded(payment.id)).toBe(total);
    db = await shop.dbOrder(order.id);
    expect(db.status).toBe('REFUNDED');
    expect(db.cancelledAt).not.toBeNull(); // cancelled once the refund was processed
    expect((await shop.stock(variant.id)).onHand).toBe(stockBefore.onHand + 2); // and restocked exactly once
    expect(db.refunds[0]).toMatchObject({
      status: 'PROCESSED',
      approvedById: finance.userId,
    });
  });

  it('a REJECTED staff cancel leaves the order where it was (not cancelled, not restocked) and it can still ship', async () => {
    const { order, variant } = await paidOrder(59_000, 1);
    const om = await s.staff('ORDER_MANAGER');
    const stockBefore = await shop.stock(variant.id);
    await staffCancel(om, order.id).expect(200);
    const r = (await shop.dbOrder(order.id)).refunds[0]!;
    const finance = await s.staff('FINANCE_MANAGER');
    await ctx
      .http()
      .post(`/api/v1/admin/refunds/${r.id}/reject`)
      .set(authed(finance))
      .send({ reason: 'Already shipped by courier' })
      .expect(200);
    const db = await shop.dbOrder(order.id);
    expect(db.status).toBe('PAID');
    expect(db.cancelledAt).toBeNull();
    expect(await shop.stock(variant.id)).toEqual(stockBefore);
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
      .set(authed(om))
      .send({ status: 'PROCESSING' })
      .expect(200);
  });

  it('after a partial refund, a customer cancel whose refund FAILS stays cancelled-and-waiting (never back to PAID)', async () => {
    const { u, order } = await paidOrder(100_000, 1);
    const req = await requestRefund(await s.staff('CUSTOMER_SUPPORT'), {
      orderId: order.id,
      amountMinor: 20_000,
      reason: 'Goodwill: late dispatch',
    });
    await approve(await s.staff('FINANCE_MANAGER'), req.body.data.id).expect(
      200,
    );
    expect((await shop.dbOrder(order.id)).status).toBe('PAID');
    ctx.razorpay.failNext.push({ match: '/refund', mode: 'reject' });
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({ reason: 'Changed my mind' })
      .expect(200);
    const db = await shop.dbOrder(order.id);
    expect(db.cancelledAt).not.toBeNull();
    expect(db.status).toBe('REFUND_PENDING'); // waiting for a manual refund, NOT shippable
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
          .set(authed(await s.staff('ORDER_MANAGER')))
          .send({ status: 'PROCESSING' })
      ).status,
    ).toBe(409);
  });

  it('a customer cancel of the same kind of order is still refunded at once (system request, no person to approve)', async () => {
    const { u, order, payment, total } = await paidOrder(59_000, 1);
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({ reason: 'Ordered by mistake' })
      .expect(200);
    expect(refunded(payment.id)).toBe(total);
  });

  it('the database refuses a person-requested refund that skips approval', async () => {
    const { order } = await paidOrder(59_000, 1);
    const om = await s.staff('ORDER_MANAGER');
    await staffCancel(om, order.id).expect(200);
    const r = (await shop.dbOrder(order.id)).refunds[0]!;
    await expect(
      ctx.prisma.refund.update({
        where: { id: r.id },
        data: { status: 'APPROVED' },
      }),
    ).rejects.toThrow(/refunds_human_approval_chk/);
  });
});

describe('partial refunds never strand an order', () => {
  it('a goodwill partial refund on a PAID order returns it to PAID, and it can still be fulfilled and delivered', async () => {
    const { order } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const finance = await s.staff('FINANCE_MANAGER');
    const om = await s.staff('ORDER_MANAGER');
    const req = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 30_000,
      reason: 'Goodwill: late dispatch',
    });
    await approve(finance, req.body.data.id).expect(200);
    expect((await shop.dbOrder(order.id)).status).toBe('PAID');
    expect((await payOf(order.id)).status).toBe('PARTIALLY_REFUNDED');
    const step = (body: Record<string, unknown>) =>
      ctx
        .http()
        .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
        .set(authed(om))
        .send(body);
    expect((await step({ status: 'PROCESSING' })).status).toBe(200);
    expect(
      (
        await step({
          status: 'SHIPPED',
          trackingCarrier: 'DTDC',
          trackingNumber: `DT${randomBytes(5).toString('hex')}`,
        })
      ).status,
    ).toBe(200);
    expect((await step({ status: 'DELIVERED' })).status).toBe(200);
    expect((await shop.dbOrder(order.id)).status).toBe('DELIVERED');
  });

  it('a goodwill partial refund while PROCESSING returns it to PROCESSING', async () => {
    const { order } = await paidOrder(100_000);
    const om = await s.staff('ORDER_MANAGER');
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
      .set(authed(om))
      .send({ status: 'PROCESSING' })
      .expect(200);
    const req = await requestRefund(await s.staff('CUSTOMER_SUPPORT'), {
      orderId: order.id,
      amountMinor: 10_000,
      reason: 'Goodwill: packaging',
    });
    await approve(await s.staff('FINANCE_MANAGER'), req.body.data.id).expect(
      200,
    );
    expect((await shop.dbOrder(order.id)).status).toBe('PROCESSING');
  });
});

describe('admin refunds: four-eyes approval', () => {
  it('support REQUESTS, finance APPROVES; the money moves only on approval; two partial refunds complete the order', async () => {
    const { order, payment } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const finance = await s.staff('FINANCE_MANAGER');

    const req1 = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 30_000,
      reason: 'Item arrived scratched',
    });
    expect(req1.status).toBe(201);
    expect(req1.body.data.status).toBe('PENDING_APPROVAL');
    expect(refunded(payment.id)).toBe(0); // nothing has moved yet
    expect((await shop.dbOrder(order.id)).status).toBe('REFUND_PENDING');
    expect((await payOf(order.id)).refundedMinor).toBe(30_000); // capacity is reserved immediately

    expect((await approve(finance, req1.body.data.id)).body.data.status).toBe(
      'PROCESSED',
    );
    expect(refunded(payment.id)).toBe(30_000);
    expect((await shop.dbOrder(order.id)).status).toBe('PAID'); // a partial refund never stops fulfilment
    expect((await payOf(order.id)).status).toBe('PARTIALLY_REFUNDED');

    const req2 = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 70_000,
      reason: 'Remaining balance goodwill',
    });
    await approve(finance, req2.body.data.id);
    expect(refunded(payment.id)).toBe(100_000);
    expect((await shop.dbOrder(order.id)).status).toBe('REFUNDED');
    expect((await payOf(order.id)).status).toBe('REFUNDED');
  });

  it('the requester can NEVER approve their own refund (even a finance manager)', async () => {
    const { order, payment } = await paidOrder(50_000);
    const finance = await s.staff('FINANCE_MANAGER');
    const req = await requestRefund(finance, {
      orderId: order.id,
      amountMinor: 10_000,
      reason: 'Courtesy credit',
    });
    const self = await approve(finance, req.body.data.id);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('FOUR_EYES_REQUIRED');
    expect(refunded(payment.id)).toBe(0);
    const other = await s.staff('FINANCE_MANAGER');
    expect((await approve(other, req.body.data.id)).status).toBe(200);
    expect(refunded(payment.id)).toBe(10_000);
  });

  it('support cannot approve (no refunds.approve); ordinary staff and customers cannot even request', async () => {
    const { u, order } = await paidOrder(50_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const req = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 5_000,
      reason: 'Minor damage',
    });
    expect((await approve(support, req.body.data.id)).status).toBe(403);
    for (const who of [
      await s.staff('ORDER_MANAGER'),
      await s.staff('ADMIN'),
      u,
    ]) {
      expect(
        (
          await requestRefund(who, {
            orderId: order.id,
            amountMinor: 100,
            reason: 'Not allowed',
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/refunds/${req.body.data.id}/approve`)
          .set(authed(u))
          .send({})
      ).status,
    ).toBe(403);
  });

  it('an approval can only happen once, and a rejected request releases its reserved balance', async () => {
    const { order, payment } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const finance = await s.staff('FINANCE_MANAGER');
    const rejected = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 60_000,
      reason: 'Disputed claim',
    });
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/refunds/${rejected.body.data.id}/reject`)
          .set(authed(finance))
          .send({ reason: 'Not eligible' })
      ).status,
    ).toBe(200);
    expect((await payOf(order.id)).refundedMinor).toBe(0);
    expect((await shop.dbOrder(order.id)).status).toBe('PAID'); // reverted: nothing was refunded
    expect((await approve(finance, rejected.body.data.id)).status).toBe(409);
    // the staff list shows the order number, so nobody has to match raw ids
    const listed = await ctx
      .http()
      .get('/api/v1/admin/refunds')
      .set(authed(finance))
      .expect(200);
    expect(listed.body.data).toContainEqual(
      expect.objectContaining({
        id: rejected.body.data.id,
        order: { orderNumber: (await shop.dbOrder(order.id)).orderNumber },
      }),
    );

    const ok = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 100_000,
      reason: 'Full refund agreed',
    });
    expect((await approve(finance, ok.body.data.id)).status).toBe(200);
    expect(
      (await approve(await s.staff('FINANCE_MANAGER'), ok.body.data.id)).status,
    ).toBe(409);
    expect(refunded(payment.id)).toBe(100_000);
  });
});

describe('refund limits', () => {
  it('cannot refund more than was captured, cumulatively', async () => {
    const { order } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    expect(
      (
        await requestRefund(support, {
          orderId: order.id,
          amountMinor: 100_001,
          reason: 'Too much',
        })
      ).body.error.code,
    ).toBe('REFUND_EXCEEDS_CAPTURED');
    expect(
      (
        await requestRefund(support, {
          orderId: order.id,
          amountMinor: 70_000,
          reason: 'First part',
        })
      ).status,
    ).toBe(201);
    const over = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 30_001,
      reason: 'Second part',
    });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_CAPTURED');
    expect(
      (
        await requestRefund(support, {
          orderId: order.id,
          amountMinor: 30_000,
          reason: 'Exact remainder',
        })
      ).status,
    ).toBe(201);
  });

  it('RACE: 12 parallel refund requests of 25% each can reserve at most 100% of the payment', async () => {
    const { order, payment } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        requestRefund(support, {
          orderId: order.id,
          amountMinor: 25_000,
          reason: 'Parallel claim',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.code === 'REFUND_EXCEEDS_CAPTURED'),
    ).toBe(true);
    const row = await payOf(order.id);
    expect(row.refundedMinor).toBe(100_000);
    expect(row.refundedMinor).toBeLessThanOrEqual(row.capturedMinor);
    expect(refunded(payment.id)).toBe(0);
  });

  it('RACE: approving the same refund from several approvers sends ONE refund to the provider', async () => {
    const { order, payment } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const approvers = await Promise.all([
      s.staff('FINANCE_MANAGER'),
      s.staff('FINANCE_MANAGER'),
      s.staff('FINANCE_MANAGER'),
    ]);
    const req = await requestRefund(support, {
      orderId: order.id,
      amountMinor: 40_000,
      reason: 'Race approval',
    });
    const results = await Promise.all(
      approvers.map((a) => approve(a, req.body.data.id)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(refunded(payment.id)).toBe(40_000);
    expect(
      ctx.razorpay.calls.filter((c) =>
        c.path.endsWith(`/${payment.id}/refund`),
      ),
    ).toHaveLength(1);
  });

  it('validates input and refuses unpaid, unknown and other states', async () => {
    const support = await s.staff('CUSTOMER_SUPPORT');
    const { variant } = await shop.fx.product({ stock: 3 });
    const u = await shop.customer();
    const unpaid = await shop.order(u, [{ variantId: variant.id }]);
    expect(
      (
        await requestRefund(support, {
          orderId: unpaid.id,
          amountMinor: 100,
          reason: 'Nothing paid',
        })
      ).status,
    ).toBe(404);
    const { order } = await paidOrder();
    for (const body of [
      { orderId: order.id, amountMinor: 0, reason: 'zero zero' },
      { orderId: order.id, amountMinor: 10.5, reason: 'fractional' },
      { orderId: order.id, amountMinor: 100 },
      {
        orderId: order.id,
        amountMinor: 100,
        reason: 'extra field',
        status: 'APPROVED',
      },
      {
        orderId: order.id,
        amountMinor: 100,
        reason: 'self approve',
        approvedById: support.userId,
      },
    ]) {
      expect(
        (await requestRefund(support, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('IDEMPOTENCY: retrying the same request (same key) creates ONE refund request', async () => {
    const { order } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const key = idem();
    const a = await requestRefund(
      support,
      { orderId: order.id, amountMinor: 20_000, reason: 'Retry safe' },
      key,
    );
    const b = await requestRefund(
      support,
      { orderId: order.id, amountMinor: 20_000, reason: 'Retry safe' },
      key,
    );
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(
      await ctx.prisma.refund.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect((await payOf(order.id)).refundedMinor).toBe(20_000);
    expect(
      (
        await requestRefund(
          support,
          { orderId: order.id, amountMinor: 20_001, reason: 'Retry safe' },
          key,
        )
      ).status,
    ).toBe(422);
  });
});

describe('provider failures: a refund is never sent twice and never silently lost', () => {
  const setup = async (amount = 40_000) => {
    const { order, payment } = await paidOrder(100_000);
    const support = await s.staff('CUSTOMER_SUPPORT');
    const finance = await s.staff('FINANCE_MANAGER');
    const req = await requestRefund(support, {
      orderId: order.id,
      amountMinor: amount,
      reason: 'Provider failure drill',
    });
    return { order, payment, finance, refundId: req.body.data.id as string };
  };

  it('TIMEOUT AFTER the provider acted: the refund stays PROCESSING; reconciliation finds it by receipt; the provider refunds exactly ONCE', async () => {
    const { order, payment, finance, refundId } = await setup();
    ctx.razorpay.failNext.push({
      match: '/refund',
      mode: 'timeout-after-effect',
    });
    await approve(finance, refundId);
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSING');
    expect(refunded(payment.id)).toBe(40_000); // it DID happen at the provider
    await ctx.prisma.refund.update({
      where: { id: refundId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await ctx.worker.runOnce();
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSED');
    expect(refunded(payment.id)).toBe(40_000); // not refunded a second time
    expect(
      ctx.razorpay.calls.filter(
        (c) => c.method === 'POST' && c.path.endsWith(`/${payment.id}/refund`),
      ),
    ).toHaveLength(1);
    expect((await shop.dbOrder(order.id)).status).toBe('PAID');
  });

  it('TIMEOUT BEFORE the provider acted: reconciliation proves there is no provider refund, then re-sends it ONCE', async () => {
    const { payment, finance, refundId } = await setup();
    ctx.razorpay.failNext.push({ match: '/refund', mode: 'timeout-no-effect' });
    await approve(finance, refundId);
    expect(refunded(payment.id)).toBe(0);
    await ctx.prisma.refund.update({
      where: { id: refundId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await ctx.worker.runOnce(); // PROCESSING + provider has no record -> back to APPROVED
    await ctx.prisma.refund.update({
      where: { id: refundId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await ctx.worker.runOnce(); // APPROVED -> executed
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSED');
    expect(refunded(payment.id)).toBe(40_000);
  });

  it('a DEFINITIVE rejection marks the refund FAILED, frees the balance and reverts the order status', async () => {
    const { order, finance, refundId } = await setup();
    ctx.razorpay.failNext.push({ match: '/refund', mode: 'reject' });
    await approve(finance, refundId);
    const r = await ctx.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
    });
    expect(r.status).toBe('FAILED');
    expect(r.failureReason).toMatch(/provider/i);
    expect((await payOf(order.id)).refundedMinor).toBe(0);
    expect((await payOf(order.id)).status).toBe('CAPTURED');
    expect((await shop.dbOrder(order.id)).status).toBe('PAID');
    // and a fresh request for the freed balance is possible
    const support = await s.staff('CUSTOMER_SUPPORT');
    expect(
      (
        await requestRefund(support, {
          orderId: order.id,
          amountMinor: 100_000,
          reason: 'Try again fully',
        })
      ).status,
    ).toBe(201);
  });

  it('a webhook claiming a DIFFERENT refund amount is not applied: the refund stays open and the discrepancy is audited', async () => {
    const { order, payment, finance, refundId } = await setup();
    ctx.razorpay.refundStatus = 'pending';
    await approve(finance, refundId);
    ctx.razorpay.refundStatus = 'processed';
    const providerRefund = [...ctx.razorpay.refunds.values()].find(
      (r) => r.payment_id === payment.id,
    )!;
    const hook = ctx.razorpay.refundWebhook(
      'refund.processed',
      {
        ...providerRefund,
        status: 'processed',
        amount: providerRefund.amount + 100,
      },
      { eventId: `evt_${randomBytes(8).toString('hex')}` },
    );
    expect((await shop.webhook(hook)).body.data.outcome).toBe('unknown');
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSING');
    expect((await shop.dbOrder(order.id)).status).toBe('REFUND_PENDING');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'refund.failed', resourceId: refundId },
      }),
    ).toBe(1);
  });

  it('a provider that answers "pending" completes via the refund.processed webhook (and a duplicate webhook changes nothing)', async () => {
    const { order, payment, finance, refundId } = await setup();
    ctx.razorpay.refundStatus = 'pending';
    await approve(finance, refundId);
    ctx.razorpay.refundStatus = 'processed';
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSING');
    const providerRefund = [...ctx.razorpay.refunds.values()].find(
      (r) => r.payment_id === payment.id,
    )!;
    const hook = ctx.razorpay.refundWebhook(
      'refund.processed',
      { ...providerRefund, status: 'processed' },
      { eventId: `evt_${randomBytes(8).toString('hex')}` },
    );
    expect((await shop.webhook(hook)).body.data.outcome).toBe('processed');
    expect((await shop.webhook(hook)).body.data.outcome).toBe('duplicate');
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSED');
    expect((await shop.dbOrder(order.id)).status).toBe('PAID');
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { aggregateId: refundId, eventType: 'refund.processed' },
      }),
    ).toBe(1);
  });

  it('a forged refund webhook is rejected', async () => {
    const { payment, finance, refundId } = await setup();
    ctx.razorpay.refundStatus = 'pending';
    await approve(finance, refundId);
    ctx.razorpay.refundStatus = 'processed';
    const pr = [...ctx.razorpay.refunds.values()].find(
      (r) => r.payment_id === payment.id,
    )!;
    const forged = ctx.razorpay.refundWebhook('refund.processed', pr, {
      secret: 'attacker_secret_0123456789abcdef',
    });
    expect((await shop.webhook(forged)).status).toBe(401);
    expect(
      (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } }))
        .status,
    ).toBe('PROCESSING');
  });
});

describe('returns', () => {
  async function delivered(opened = false) {
    const ctxOrder = await paidOrder(60_000, 2);
    const om = await s.staff('ORDER_MANAGER');
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${ctxOrder.order.id}/fulfilment`)
      .set(authed(om))
      .send({ status: 'PROCESSING' });
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${ctxOrder.order.id}/fulfilment`)
      .set(authed(om))
      .send({
        status: 'SHIPPED',
        trackingCarrier: 'DTDC',
        trackingNumber: `DT${randomBytes(5).toString('hex')}`,
      });
    await ctx
      .http()
      .post(`/api/v1/admin/orders/${ctxOrder.order.id}/fulfilment`)
      .set(authed(om))
      .send({ status: 'DELIVERED' });
    const db = await shop.dbOrder(ctxOrder.order.id);
    return { ...ctxOrder, om, itemId: db.items[0]!.id, opened };
  }
  const requestReturn = (
    u: Session,
    orderId: string,
    body: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .post(`/api/v1/orders/${orderId}/returns`)
      .set(authed(u))
      .send(body);

  it('full flow: customer requests -> staff approve -> goods received (unopened = restocked) -> refund request -> finance approves -> REFUNDED', async () => {
    const { u, order, variant, payment, om, itemId } = await delivered();
    const ret = await requestReturn(u, order.id, {
      orderItemId: itemId,
      quantity: 1,
      reason: 'WRONG_ITEM',
      opened: false,
    });
    expect(ret.status).toBe(201);
    expect((await shop.dbOrder(order.id)).status).toBe('RETURN_REQUESTED');

    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/returns/${ret.body.data.id}/decision`)
          .set(authed(om))
          .send({ decision: 'APPROVED', note: 'Please ship it back' })
      ).status,
    ).toBe(200);
    expect((await shop.dbOrder(order.id)).status).toBe('RETURN_APPROVED');
    const stockBefore = (await shop.stock(variant.id)).onHand;
    const received = await ctx
      .http()
      .post(`/api/v1/admin/returns/${ret.body.data.id}/received`)
      .set(authed(om))
      .send({});
    expect(received.status).toBe(200);
    expect((await shop.stock(variant.id)).onHand).toBe(stockBefore + 1); // unopened -> sellable again
    expect(received.body.data).toMatchObject({
      amountMinor: 60_000,
      status: 'PENDING_APPROVAL',
      kind: 'RETURN',
    });

    const finance = await s.staff('FINANCE_MANAGER');
    expect((await approve(finance, received.body.data.id)).status).toBe(200);
    expect(refunded(payment.id)).toBe(60_000);
    expect((await shop.dbOrder(order.id)).status).toBe('DELIVERED'); // one of two units returned: the other may still be
    expect(
      (
        await ctx.prisma.returnRequest.findUniqueOrThrow({
          where: { id: ret.body.data.id },
        })
      ).status,
    ).toBe('REFUNDED');
  });

  const returnAndRefund = async (
    u: Session,
    orderId: string,
    itemId: string,
    om: Session,
    quantity = 1,
  ) => {
    const ret = await requestReturn(u, orderId, {
      orderItemId: itemId,
      quantity,
      reason: 'WRONG_ITEM',
      opened: false,
    });
    expect(ret.status).toBe(201);
    await ctx
      .http()
      .post(`/api/v1/admin/returns/${ret.body.data.id}/decision`)
      .set(authed(om))
      .send({ decision: 'APPROVED' })
      .expect(200);
    const received = await ctx
      .http()
      .post(`/api/v1/admin/returns/${ret.body.data.id}/received`)
      .set(authed(om))
      .send({});
    expect(received.status).toBe(200);
    await approve(
      await s.staff('FINANCE_MANAGER'),
      received.body.data.id,
    ).expect(200);
  };

  it('after one unit is returned and refunded, the remaining unit can still be returned; returning it all completes the refund', async () => {
    const { u, order, payment, om, itemId } = await delivered();
    await returnAndRefund(u, order.id, itemId, om);
    expect((await shop.dbOrder(order.id)).status).toBe('DELIVERED');
    await returnAndRefund(u, order.id, itemId, om);
    expect(refunded(payment.id)).toBe(120_000);
    expect((await shop.dbOrder(order.id)).status).toBe('REFUNDED');
  });

  it('when every unit is back but the delivery fee is kept, the order closes as PARTIALLY_REFUNDED', async () => {
    const code = `FEE${randomBytes(3).toString('hex').toUpperCase()}`;
    await ctx.prisma.shippingMethod.create({
      data: {
        code,
        name: 'Paid delivery',
        baseMinor: 5_000,
        freeAboveMinor: null,
        etaMinDays: 2,
        etaMaxDays: 4,
        states: [],
      },
    });
    try {
      const { variant } = await shop.fx.product({
        priceMinor: 60_000,
        stock: 5,
      });
      const cust = await shop.customer();
      const order = await shop.order(
        cust,
        [{ variantId: variant.id, quantity: 1 }],
        {
          shippingMethodCode: code,
        },
      );
      expect(order.totals.totalMinor).toBe(65_000);
      await shop.paid(cust, order.id);
      const om = await s.staff('ORDER_MANAGER');
      for (const body of [
        { status: 'PROCESSING' },
        {
          status: 'SHIPPED',
          trackingCarrier: 'DTDC',
          trackingNumber: `DT${randomBytes(5).toString('hex')}`,
        },
        { status: 'DELIVERED' },
      ])
        await ctx
          .http()
          .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
          .set(authed(om))
          .send(body)
          .expect(200);
      const itemId = (await shop.dbOrder(order.id)).items[0]!.id;
      await returnAndRefund(cust, order.id, itemId, om);
      expect((await payOf(order.id)).refundedMinor).toBe(60_000); // the item, not the delivery fee
      expect((await shop.dbOrder(order.id)).status).toBe('PARTIALLY_REFUNDED');
    } finally {
      await ctx.prisma.shippingMethod.deleteMany({ where: { code } });
    }
  });

  it('an OPENED item is refunded but not put back on sale', async () => {
    const { u, order, variant, om, itemId } = await delivered();
    const ret = await requestReturn(u, order.id, {
      orderItemId: itemId,
      quantity: 1,
      reason: 'FAULTY',
      opened: true,
      details: 'Stopped working after two days',
    });
    await ctx
      .http()
      .post(`/api/v1/admin/returns/${ret.body.data.id}/decision`)
      .set(authed(om))
      .send({ decision: 'APPROVED' });
    const before = (await shop.stock(variant.id)).onHand;
    await ctx
      .http()
      .post(`/api/v1/admin/returns/${ret.body.data.id}/received`)
      .set(authed(om))
      .send({});
    expect((await shop.stock(variant.id)).onHand).toBe(before);
  });

  it('a rejected return reopens nothing: the order goes back to DELIVERED', async () => {
    const { u, order, om, itemId } = await delivered();
    const ret = await requestReturn(u, order.id, {
      orderItemId: itemId,
      quantity: 1,
      reason: 'OTHER',
      opened: false,
      details: 'I changed my mind',
    });
    await ctx
      .http()
      .post(`/api/v1/admin/returns/${ret.body.data.id}/decision`)
      .set(authed(om))
      .send({ decision: 'REJECTED', note: 'Outside policy' });
    expect((await shop.dbOrder(order.id)).status).toBe('DELIVERED');
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/returns/${ret.body.data.id}/received`)
          .set(authed(om))
          .send({})
      ).status,
    ).toBe(409);
  });

  it('enforces the rules: delivered only, return window, quantity, one open return, ownership, reason details', async () => {
    const { u, order, itemId } = await delivered();
    const base = { orderItemId: itemId, reason: 'WRONG_ITEM', opened: false };
    expect(
      (await requestReturn(u, order.id, { ...base, quantity: 3 })).body.error
        .code,
    ).toBe('RETURN_QUANTITY_EXCEEDED');
    expect(
      (
        await requestReturn(u, order.id, {
          ...base,
          quantity: 1,
          reason: 'FAULTY',
        })
      ).status,
    ).toBe(400); // details required
    expect(
      (
        await requestReturn(u, order.id, {
          ...base,
          quantity: 1,
          status: 'APPROVED',
        })
      ).status,
    ).toBe(400); // mass assignment
    expect(
      (await requestReturn(u, order.id, { ...base, quantity: 1 })).status,
    ).toBe(201);
    expect(
      (await requestReturn(u, order.id, { ...base, quantity: 1 })).status,
    ).toBe(409); // one open return

    const stranger = await shop.customer();
    expect(
      (await requestReturn(stranger, order.id, { ...base, quantity: 1 }))
        .status,
    ).toBe(404);

    const late = await delivered();
    await ctx.prisma.order.update({
      where: { id: late.order.id },
      data: { deliveredAt: new Date(Date.now() - 30 * 86_400_000) },
    });
    expect(
      (
        await requestReturn(late.u, late.order.id, {
          orderItemId: late.itemId,
          quantity: 1,
          reason: 'WRONG_ITEM',
          opened: false,
        })
      ).body.error.code,
    ).toBe('RETURN_WINDOW_CLOSED');

    const undelivered = await paidOrder();
    expect(
      (
        await requestReturn(undelivered.u, undelivered.order.id, {
          orderItemId: '0190a7c0-0000-7000-8000-000000000000',
          quantity: 1,
          reason: 'WRONG_ITEM',
          opened: false,
        })
      ).body.error.code,
    ).toBe('ORDER_NOT_RETURNABLE');
  });

  it('customers cannot decide or receive returns; only staff with orders.update', async () => {
    const { u, order, itemId } = await delivered();
    const ret = await requestReturn(u, order.id, {
      orderItemId: itemId,
      quantity: 1,
      reason: 'WRONG_ITEM',
      opened: false,
    });
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/returns/${ret.body.data.id}/decision`)
          .set(authed(u))
          .send({ decision: 'APPROVED' })
      ).status,
    ).toBe(403);
    const pm = await s.staff('PRODUCT_MANAGER');
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/returns/${ret.body.data.id}/decision`)
          .set(authed(pm))
          .send({ decision: 'APPROVED' })
      ).status,
    ).toBe(403);
  });
});

describe('fulfilment and invoices', () => {
  it('moves PAID -> PROCESSING -> SHIPPED (tracking required) -> DELIVERED in order; skipping steps is refused', async () => {
    const { u, order } = await paidOrder();
    const om = await s.staff('ORDER_MANAGER');
    const go = (body: Record<string, unknown>) =>
      ctx
        .http()
        .post(`/api/v1/admin/orders/${order.id}/fulfilment`)
        .set(authed(om))
        .send(body);
    expect(
      (await go({ status: 'SHIPPED', trackingNumber: 'DT111111' })).status,
    ).toBe(409);
    expect((await go({ status: 'DELIVERED' })).status).toBe(409);
    expect((await go({ status: 'PROCESSING' })).status).toBe(200);
    expect((await go({ status: 'SHIPPED' })).status).toBe(409); // tracking number missing
    expect(
      (
        await go({
          status: 'SHIPPED',
          trackingCarrier: 'DTDC',
          trackingNumber: 'DT111111',
        })
      ).status,
    ).toBe(200);
    expect((await go({ status: 'DELIVERED' })).status).toBe(200);
    expect((await go({ status: 'PROCESSING' })).status).toBe(409); // cannot go backwards
    const view = (await shop.getOrder(u, order.id)).body.data;
    expect(view.status).toBe('DELIVERED');
    expect(view.tracking).toEqual({ carrier: 'DTDC', number: 'DT111111' });
    expect(
      view.timeline.map((t: { status: string }) => t.status).slice(-3),
    ).toEqual(['PROCESSING', 'SHIPPED', 'DELIVERED']);
    await ctx.drainOutbox();
    expect(ctx.notifier.last('ORDER_SHIPPED', u.email)).toBeDefined();
    expect(ctx.notifier.last('ORDER_DELIVERED', u.email)).toBeDefined();
  });

  it('unpaid orders cannot be fulfilled; customers and non-order staff cannot fulfil', async () => {
    const { variant } = await shop.fx.product({ stock: 3 });
    const u = await shop.customer();
    const unpaid = await shop.order(u, [{ variantId: variant.id }]);
    const om = await s.staff('ORDER_MANAGER');
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/orders/${unpaid.id}/fulfilment`)
          .set(authed(om))
          .send({ status: 'PROCESSING' })
      ).status,
    ).toBe(409);
    const paid = await paidOrder();
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/orders/${paid.order.id}/fulfilment`)
          .set(authed(paid.u))
          .send({ status: 'PROCESSING' })
      ).status,
    ).toBe(403);
    const finance = await s.staff('FINANCE_MANAGER');
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/orders/${paid.order.id}/fulfilment`)
          .set(authed(finance))
          .send({ status: 'PROCESSING' })
      ).status,
    ).toBe(403);
  });

  it('GST invoice: CGST+SGST in-state, IGST out of state, sums to the order, only after payment, only for the owner', async () => {
    const { variant } = await shop.fx.product({ priceMinor: 59_000, stock: 5 });
    const inState = await shop.customer('Tamil Nadu');
    const outState = await shop.customer('Karnataka');
    const a = await shop.order(inState, [
      { variantId: variant.id, quantity: 2 },
    ]);
    const b = await shop.order(outState, [
      { variantId: variant.id, quantity: 1 },
    ]);
    expect(
      (
        await ctx
          .http()
          .get(`/api/v1/orders/${a.id}/invoice`)
          .set(authed(inState))
      ).status,
    ).toBe(404); // not paid yet
    await shop.paid(inState, a.id);
    await shop.paid(outState, b.id);

    const ia = (
      await ctx
        .http()
        .get(`/api/v1/orders/${a.id}/invoice`)
        .set(authed(inState))
    ).body.data;
    expect(ia).toMatchObject({
      supply: 'INTRA_STATE',
      placeOfSupply: 'Tamil Nadu',
      totals: {
        totalMinor: 118_000,
        gstIncludedMinor: 18_000,
        taxableValueMinor: 100_000,
      },
      taxInvoice: false,
    });
    expect(ia.lines[0]).toMatchObject({
      cgstMinor: 9_000,
      sgstMinor: 9_000,
      igstMinor: 0,
      taxableValueMinor: 100_000,
      gstRateBps: 1800,
    });
    const ib = (
      await ctx
        .http()
        .get(`/api/v1/orders/${b.id}/invoice`)
        .set(authed(outState))
    ).body.data;
    expect(ib).toMatchObject({ supply: 'INTER_STATE' });
    expect(ib.lines[0]).toMatchObject({
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 9_000,
    });
    expect(
      (
        await ctx
          .http()
          .get(`/api/v1/orders/${a.id}/invoice`)
          .set(authed(outState))
      ).status,
    ).toBe(404);
  });

  it('admin order views need permissions; payments are visible only with payments.read', async () => {
    const { order } = await paidOrder();
    const om = await s.staff('ORDER_MANAGER');
    const finance = await s.staff('FINANCE_MANAGER');
    expect(
      (await ctx.http().get(`/api/v1/admin/orders/${order.id}`).set(authed(om)))
        .status,
    ).toBe(200);
    expect(
      (
        await ctx
          .http()
          .get(`/api/v1/admin/orders/${order.id}/payments`)
          .set(authed(om))
      ).status,
    ).toBe(403);
    const pays = await ctx
      .http()
      .get(`/api/v1/admin/orders/${order.id}/payments`)
      .set(authed(finance));
    expect(pays.status).toBe(200);
    expect(JSON.stringify(pays.body)).not.toMatch(
      /key_secret|webhook_secret|razorpay_signature/,
    );
    const customer = await s.session();
    expect(
      (await ctx.http().get('/api/v1/admin/orders').set(authed(customer)))
        .status,
    ).toBe(403);
    expect(await waitFor(() => Promise.resolve(true))).toBe(true);
  });
});
