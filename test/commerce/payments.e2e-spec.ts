import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { FakeRazorpayApi, TEST_KEY_SECRET } from '../support/fake-razorpay.js';
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
/** A customer with an unpaid order of one item priced `priceMinor`, payment already initiated. */
async function pending(priceMinor = 59_000, stock = 5, quantity = 1) {
  const { variant } = await shop.fx.product({ priceMinor, stock });
  const u: Cust = await shop.customer();
  const order = await shop.order(u, [{ variantId: variant.id, quantity }]);
  const init = await shop.startPayment(u, order.id);
  return { u, order, variant, init };
}
const status = async (orderId: string) => (await shop.dbOrder(orderId)).status;
const events = (paymentId: string) =>
  ctx.prisma.paymentEvent.findMany({
    where: { paymentId },
    orderBy: { createdAt: 'asc' },
  });

describe('initiating payment', () => {
  it('creates a provider order for the EXACT amount in paise and returns only public config', async () => {
    const { u, order, init } = await pending(59_000, 5, 2);
    expect(init).toMatchObject({
      amountMinor: 118_000,
      keyId: 'rzp_test_AbCdEf1234',
    });
    const created = ctx.razorpay.orders.get(init.providerOrderId)!;
    expect(created).toMatchObject({
      amount: 118_000,
      currency: 'INR',
      receipt: order.orderNumber,
    });
    expect(JSON.stringify(init)).not.toContain(TEST_KEY_SECRET);
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
    expect(
      await ctx.prisma.payment.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect(u.userId).toBeTruthy();
  });

  it('is idempotent: retries and new keys reuse the SAME provider order (never two payable orders)', async () => {
    const { u, order, init } = await pending();
    const sameKey = `same-${randomBytes(6).toString('hex')}`;
    const a = await shop.initiate(u, order.id, sameKey);
    const b = await shop.initiate(u, order.id, sameKey);
    const c = await shop.initiate(u, order.id);
    for (const r of [a, b, c])
      expect(r.body.data.providerOrderId).toBe(init.providerOrderId);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(ctx.razorpay.orders.size).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.prisma.payment.count({ where: { orderId: order.id } }),
    ).toBe(1);
  });

  it('concurrent initiations create exactly one payment and one provider order', async () => {
    const { variant } = await shop.fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    const before = ctx.razorpay.orders.size;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => shop.initiate(u, order.id)),
    );
    expect(results.every((r) => [200, 409, 503].includes(r.status))).toBe(true);
    expect(
      await ctx.prisma.payment.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect(ctx.razorpay.orders.size - before).toBe(1);
  });

  it('refuses expired orders, and requires an Idempotency-Key', async () => {
    const { variant } = await shop.fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/orders/${order.id}/payments`)
          .set(authed(u))
          .send({})
      ).status,
    ).toBe(400);
    await ctx.prisma.order.update({
      where: { id: order.id },
      data: {
        paymentExpiresAt: new Date(Date.now() - 1000),
        placedAt: new Date(Date.now() - 7_200_000),
      },
    });
    expect((await shop.initiate(u, order.id)).body.error.code).toBe(
      'ORDER_NOT_PAYABLE',
    );
  });

  it('a provider outage is reported cleanly and nothing is half-created', async () => {
    const { variant } = await shop.fx.product({ stock: 5 });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    ctx.razorpay.failNext.push({ match: '/orders', mode: 'timeout-no-effect' });
    const res = await shop.initiate(u, order.id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(await status(order.id)).toBe('INVENTORY_RESERVED');
    expect((await shop.initiate(u, order.id)).status).toBe(200); // retry works
  });
});

describe('a genuine payment (webhook)', () => {
  it('marks the order PAID, commits stock once, records the financial trail and notifies the customer', async () => {
    const { u, order, variant, init } = await pending(59_000, 5, 2);
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.captured', p),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      received: true,
      outcome: 'captured',
    });

    const db = await shop.dbOrder(order.id);
    expect(db.status).toBe('PAID');
    expect(db.paidAt).not.toBeNull();
    expect(db.payments[0]).toMatchObject({
      status: 'CAPTURED',
      capturedMinor: 118_000,
      providerPaymentId: p.id,
      method: 'upi',
    });
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 3,
      reserved: 0,
    }); // sold, not just held
    expect(db.history.map((h) => h.toStatus)).toEqual([
      'CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_PENDING',
      'PAID',
    ]);

    const trail = (await events(db.payments[0]!.id)).map((e) => e.type);
    expect(trail).toEqual(['payment.initiated', 'payment.captured']);
    // PII from the provider payload (email, phone, card) is never stored
    expect(JSON.stringify(await events(db.payments[0]!.id))).not.toMatch(
      /customer@example|4242|\+9198765/,
    );

    await ctx.drainOutbox();
    await waitFor(() => ctx.notifier.last('ORDER_CONFIRMED'));
    expect(ctx.notifier.last('ORDER_CONFIRMED', u.email)).toMatchObject({
      orderNumber: order.orderNumber,
      totalMinor: 118_000,
    });
    expect((await shop.getOrder(u, order.id)).body.data).toMatchObject({
      status: 'PAID',
    });
  });
});

describe('webhook authenticity and replay protection', () => {
  it('rejects a missing, malformed or forged signature (401) and changes NOTHING', async () => {
    const { order, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const good = ctx.razorpay.paymentWebhook('payment.captured', p);
    const bads = [
      {
        raw: good.raw,
        headers: { ...good.headers, 'x-razorpay-signature': '' },
      },
      {
        raw: good.raw,
        headers: { ...good.headers, 'x-razorpay-signature': 'f'.repeat(64) },
      },
      ctx.razorpay.paymentWebhook('payment.captured', p, {
        secret: 'attacker_secret_0123456789abcdef',
      }),
    ];
    for (const b of bads) expect((await shop.webhook(b)).status).toBe(401);
    const noSig = { ...good.headers } as Record<string, string>;
    delete noSig['x-razorpay-signature'];
    expect((await shop.webhook({ raw: good.raw, headers: noSig })).status).toBe(
      401,
    );
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'payment.webhook_rejected' },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('rejects a body altered after signing (e.g. a smaller amount or another payment id)', async () => {
    const { order, init } = await pending(59_000);
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const good = ctx.razorpay.paymentWebhook('payment.captured', p);
    expect(
      (
        await shop.webhook({
          raw: good.raw.replace('"amount":59000', '"amount":100'),
          headers: good.headers,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await shop.webhook({
          raw: JSON.stringify(JSON.parse(good.raw), null, 2),
          headers: good.headers,
        })
      ).status,
    ).toBe(401); // re-serialised
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
  });

  it('a validly signed but unparsable or id-less delivery is a 400, not a crash', async () => {
    const raw = 'not json at all';
    const headers = {
      'content-type': 'application/json',
      'x-razorpay-signature': FakeRazorpayApi.sign(
        'test_webhook_secret_0123456789ab',
        raw,
      ),
      'x-razorpay-event-id': 'evt_bad_payload_1',
    };
    expect((await shop.webhook({ raw, headers })).status).toBe(400);
    const { init } = await pending();
    const good = ctx.razorpay.paymentWebhook(
      'payment.captured',
      ctx.razorpay.pay(init.providerOrderId, 'captured'),
    );
    const noId = { ...good.headers } as Record<string, string>;
    delete noId['x-razorpay-event-id'];
    expect((await shop.webhook({ raw: good.raw, headers: noId })).status).toBe(
      400,
    );
  });

  it('REPLAY: the same event delivered again is acknowledged but processed ONCE', async () => {
    const { order, variant, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const w = ctx.razorpay.paymentWebhook('payment.captured', p, {
      eventId: `evt_${randomBytes(8).toString('hex')}`,
    });
    expect((await shop.webhook(w)).body.data.outcome).toBe('captured');
    for (let i = 0; i < 3; i++)
      expect((await shop.webhook(w)).body.data.outcome).toBe('duplicate');
    expect(await status(order.id)).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
    const payment = (await shop.dbOrder(order.id)).payments[0]!;
    expect(
      (await events(payment.id)).filter((e) => e.type === 'payment.captured'),
    ).toHaveLength(1);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { aggregateId: order.id, eventType: 'order.paid' },
      }),
    ).toBe(1);
  });

  it('CONCURRENT redelivery (5 parallel identical webhooks): exactly one effect', async () => {
    const { order, variant, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const w = ctx.razorpay.paymentWebhook('payment.captured', p, {
      eventId: `evt_${randomBytes(8).toString('hex')}`,
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => shop.webhook(w)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      results.filter((r) => r.body.data.outcome === 'captured'),
    ).toHaveLength(1);
    expect(await status(order.id)).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
  });

  it('DISTINCT event ids for the same capture (provider resend) still change nothing the second time', async () => {
    const { order, variant, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    expect(
      (await shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', p)))
        .body.data.outcome,
    ).toBe('captured');
    expect(
      (await shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', p)))
        .body.data.outcome,
    ).toBe('duplicate');
    expect(await shop.stock(variant.id)).toMatchObject({ onHand: 4 });
    expect(await status(order.id)).toBe('PAID');
  });

  it('events older than the replay window are acknowledged and ignored; unknown provider orders are ignored', async () => {
    const { order, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const old = ctx.razorpay.paymentWebhook('payment.captured', p, {
      createdAt: Math.floor(Date.now() / 1000) - 8 * 86_400,
    });
    expect((await shop.webhook(old)).body.data.outcome).toBe('stale');
    expect(await status(order.id)).toBe('PAYMENT_PENDING');

    ctx.razorpay.orders.set('order_foreign', {
      id: 'order_foreign',
      amount: 100,
      currency: 'INR',
      receipt: 'x',
      status: 'created',
    });
    const foreign = ctx.razorpay.pay('order_foreign', 'captured');
    expect(
      (
        await shop.webhook(
          ctx.razorpay.paymentWebhook('payment.captured', foreign),
        )
      ).body.data.outcome,
    ).toBe('unknown_order');
  });
});

describe('amount integrity', () => {
  it('a capture for the WRONG amount never marks the order paid and raises an audit alarm', async () => {
    const { order, variant, init } = await pending(59_000);
    const underpaid = ctx.razorpay.pay(init.providerOrderId, 'captured', {
      amount: 100,
    });
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.captured', underpaid),
    );
    expect(res.body.data.outcome).toBe('mismatch');
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 5,
      reserved: 1,
    });
    expect((await shop.dbOrder(order.id)).payments[0]).toMatchObject({
      status: 'PENDING',
      capturedMinor: 0,
    });
    const audit = await ctx.prisma.auditLog.findFirst({
      where: {
        action: 'payment.amount_mismatch',
        resourceId: (await shop.dbOrder(order.id)).payments[0]!.id,
      },
    });
    expect(audit?.metadata).toMatchObject({
      expectedMinor: 59_000,
      receivedMinor: 100,
    });
  });

  it('a capture in a different currency is rejected the same way', async () => {
    const { order, init } = await pending();
    const usd = ctx.razorpay.pay(init.providerOrderId, 'captured', {
      currency: 'USD',
    });
    expect(
      (await shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', usd)))
        .body.data.outcome,
    ).toBe('mismatch');
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
  });

  it('webhook payload claims are NOT trusted: the provider is asked for the truth', async () => {
    const { order, init } = await pending();
    const real = ctx.razorpay.pay(init.providerOrderId, 'failed'); // really failed at the bank
    // A (validly signed) event that CLAIMS capture for that payment id: the provider's own record wins.
    const claim = ctx.razorpay.paymentWebhook('payment.captured', {
      ...real,
      status: 'captured',
    });
    const res = await shop.webhook(claim);
    expect(res.body.data.outcome).toBe('failed');
    expect(await status(order.id)).toBe('PAYMENT_FAILED');
  });

  it('REPLAY: the event-id header is not signed, so a replay with FRESH ids is recognised by its signed body - and costs no provider request', async () => {
    const { order, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const w = ctx.razorpay.paymentWebhook('payment.captured', p, {
      eventId: `evt_${randomBytes(8).toString('hex')}`,
    });
    expect((await shop.webhook(w)).body.data.outcome).toBe('captured');
    const before = ctx.razorpay.calls.length;
    for (let i = 0; i < 4; i++) {
      const replay = {
        raw: w.raw, // identical signed bytes
        headers: {
          ...w.headers,
          'x-razorpay-event-id': `evt_fresh_${randomBytes(8).toString('hex')}`,
        },
      };
      const res = await shop.webhook(replay);
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('duplicate');
    }
    // and the exact same delivery again
    expect((await shop.webhook(w)).body.data.outcome).toBe('duplicate');
    expect(ctx.razorpay.calls.length).toBe(before); // no amplification towards the provider
    expect(await status(order.id)).toBe('PAID');
    expect(
      await ctx.prisma.webhookInbox.count({
        where: { providerEventId: { startsWith: 'evt_fresh_' } },
      }),
    ).toBe(0);
  });

  it('if the provider cannot be asked, the webhook gets a 5xx (so it is retried) and leaves no trace; the retry then works', async () => {
    const { order, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const w = ctx.razorpay.paymentWebhook('payment.captured', p, {
      eventId: 'evt_retry_after_outage_1',
    });
    ctx.razorpay.failNext.push({
      match: `/payments/${p.id}`,
      mode: 'timeout-no-effect',
    });
    expect((await shop.webhook(w)).status).toBe(503);
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
    expect(
      await ctx.prisma.webhookInbox.count({
        where: { providerEventId: 'evt_retry_after_outage_1' },
      }),
    ).toBe(0);
    expect((await shop.webhook(w)).body.data.outcome).toBe('captured');
    expect(await status(order.id)).toBe('PAID');
  });
});

describe('the browser callback is verified, never believed', () => {
  it('confirms a real payment with a valid signature (no webhook needed)', async () => {
    const { u, order, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const res = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/payments/confirm`)
      .set(authed(u))
      .send(ctx.razorpay.checkoutCallback(p));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ paid: true, status: 'PAID' });
    expect(await status(order.id)).toBe('PAID');
  });

  it('a FORGED callback signature is refused and audited; the order stays unpaid', async () => {
    const { u, order, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const forged = {
      ...ctx.razorpay.checkoutCallback(p),
      razorpay_signature: FakeRazorpayApi.sign(
        'guessed_secret_guessed_secret_xx',
        `${p.order_id}|${p.id}`,
      ),
    };
    const res = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/payments/confirm`)
      .set(authed(u))
      .send(forged);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'payment.callback_rejected', actorId: u.userId },
      }),
    ).toBe(1);
  });

  it('a valid signature does not help if the payment actually FAILED at the provider', async () => {
    const { u, order, init } = await pending();
    const failed = ctx.razorpay.pay(init.providerOrderId, 'failed');
    const res = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/payments/confirm`)
      .set(authed(u))
      .send(ctx.razorpay.checkoutCallback(failed));
    expect(res.body.data).toMatchObject({
      paid: false,
      status: 'PAYMENT_FAILED',
    });
  });

  it('cannot pay order A with a genuine payment made for order B', async () => {
    const a = await pending(10_000);
    const b = await pending(10_000);
    const paidForB = ctx.razorpay.pay(b.init.providerOrderId, 'captured');
    // attacker (owner of A) replays B's genuine callback against A
    const res = await ctx
      .http()
      .post(`/api/v1/orders/${a.order.id}/payments/confirm`)
      .set(authed(a.u))
      .send(ctx.razorpay.checkoutCallback(paidForB));
    expect(res.status).toBe(400);
    expect(await status(a.order.id)).toBe('PAYMENT_PENDING');
    // and ownership still applies: user A cannot confirm against order B either
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/orders/${b.order.id}/payments/confirm`)
          .set(authed(a.u))
          .send(ctx.razorpay.checkoutCallback(paidForB))
      ).status,
    ).toBe(404);
  });

  it('is idempotent: replaying the callback after the order is paid changes nothing', async () => {
    const { u, order, variant, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const body = ctx.razorpay.checkoutCallback(p);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await ctx
            .http()
            .post(`/api/v1/orders/${order.id}/payments/confirm`)
            .set(authed(u))
            .send(body)
        ).status,
      ).toBe(200);
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
    expect(
      await ctx.prisma.paymentEvent.count({
        where: { payment: { orderId: order.id }, type: 'payment.captured' },
      }),
    ).toBe(1);
  });

  it('webhook + callback racing for the same payment produce exactly one capture', async () => {
    const { u, order, variant, init } = await pending();
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const results = await Promise.all([
      shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', p)),
      ctx
        .http()
        .post(`/api/v1/orders/${order.id}/payments/confirm`)
        .set(authed(u))
        .send(ctx.razorpay.checkoutCallback(p)),
      shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', p)),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await status(order.id)).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
    expect(
      await ctx.prisma.paymentEvent.count({
        where: { payment: { orderId: order.id }, type: 'payment.captured' },
      }),
    ).toBe(1);
  });
});

describe('failures, retries and out-of-order delivery', () => {
  it('payment.failed moves the order to PAYMENT_FAILED; retrying reuses the same provider order and a later success wins', async () => {
    const { u, order, init } = await pending();
    const bad = ctx.razorpay.pay(init.providerOrderId, 'failed');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.failed', bad));
    expect(await status(order.id)).toBe('PAYMENT_FAILED');
    await ctx.drainOutbox();
    expect(ctx.notifier.last('PAYMENT_FAILED', u.email)).toBeDefined();

    const retry = await shop.initiate(u, order.id);
    expect(retry.body.data.providerOrderId).toBe(init.providerOrderId);
    expect(await status(order.id)).toBe('PAYMENT_PENDING');
    const good = ctx.razorpay.pay(init.providerOrderId, 'captured');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', good));
    expect(await status(order.id)).toBe('PAID');
  });

  it('a late "failed" event for an EARLIER attempt cannot undo a captured payment (out of order)', async () => {
    const { order, init } = await pending();
    const earlierFailure = ctx.razorpay.pay(init.providerOrderId, 'failed');
    const success = ctx.razorpay.pay(init.providerOrderId, 'captured');
    await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.captured', success),
    );
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.failed', earlierFailure),
    );
    expect(res.status).toBe(200);
    expect(await status(order.id)).toBe('PAID');
    expect((await shop.dbOrder(order.id)).payments[0]!.status).toBe('CAPTURED');
  });

  it('authorized -> automatically captured -> order PAID', async () => {
    const { order, variant, init } = await pending();
    const auth = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.authorized', auth),
    );
    expect(res.body.data.outcome).toBe('authorized');
    expect(ctx.razorpay.payments.get(auth.id)!.status).toBe('captured'); // we called the capture API
    expect(await status(order.id)).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
  });

  it('a capture that fails once is retried by reconciliation (the order is not left to expire)', async () => {
    const { order, init } = await pending();
    ctx.razorpay.failNext.push({
      match: '/capture',
      mode: 'timeout-no-effect',
    });
    const auth = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.authorized', auth),
    );
    expect(res.status).toBe(200);
    expect(ctx.razorpay.payments.get(auth.id)!.status).toBe('authorized'); // the capture call failed
    expect(await status(order.id)).toBe('PAYMENT_PENDING');

    // the failed attempt holds the capture claim for 2 minutes; afterwards reconciliation retries it
    await ctx.prisma.payment.updateMany({
      where: { orderId: order.id },
      data: {
        updatedAt: new Date(Date.now() - 10 * 60_000),
        captureStartedAt: new Date(Date.now() - 3 * 60_000),
      },
    });
    await ctx.worker.reconcilePayments();
    expect(ctx.razorpay.payments.get(auth.id)!.status).toBe('captured');
    expect(await status(order.id)).toBe('PAID');
  });

  it('NO DOUBLE CHARGE: after a capture that timed out but worked, a second authorization is never captured', async () => {
    const { order, init } = await pending();
    ctx.razorpay.failNext.push({
      match: '/capture',
      mode: 'timeout-after-effect',
    });
    const a = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.authorized', a));
    expect(ctx.razorpay.payments.get(a.id)!.status).toBe('captured'); // captured at the provider…
    expect(await status(order.id)).toBe('PAYMENT_PENDING'); // …but we never heard back

    // a second authorization on the same provider order (another tab, a UPI retry) arrives
    const b = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.authorized', b));
    expect(ctx.razorpay.payments.get(b.id)!.status).toBe('authorized'); // never captured

    // once the claim is stale, reconciliation finds the capture that DID happen and applies it
    await ctx.prisma.payment.updateMany({
      where: { orderId: order.id },
      data: {
        updatedAt: new Date(Date.now() - 10 * 60_000),
        captureStartedAt: new Date(Date.now() - 3 * 60_000),
      },
    });
    await ctx.worker.reconcilePayments();
    expect(await status(order.id)).toBe('PAID');
    expect(ctx.razorpay.payments.get(b.id)!.status).toBe('authorized');
    expect(
      [...ctx.razorpay.payments.values()].filter(
        (p) => p.order_id === init.providerOrderId && p.status === 'captured',
      ),
    ).toHaveLength(1);
  });

  it('NO DOUBLE CHARGE (stale claim): a second authorization arriving later applies the capture that happened instead', async () => {
    const { order, init } = await pending();
    ctx.razorpay.failNext.push({
      match: '/capture',
      mode: 'timeout-after-effect',
    });
    const a = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.authorized', a));
    expect(ctx.razorpay.payments.get(a.id)!.status).toBe('captured');
    // the claim of that attempt has gone stale before anything else happened
    await ctx.prisma.payment.updateMany({
      where: { orderId: order.id },
      data: { captureStartedAt: new Date(Date.now() - 3 * 60_000) },
    });
    const capturesBefore = ctx.razorpay.calls.filter((c) =>
      c.path.endsWith('/capture'),
    ).length;
    const b = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.authorized', b));
    expect(
      ctx.razorpay.calls.filter((c) => c.path.endsWith('/capture')).length,
    ).toBe(capturesBefore); // no capture call
    expect(ctx.razorpay.payments.get(b.id)!.status).toBe('authorized');
    expect(await status(order.id)).toBe('PAID'); // A's capture was found and applied
  });

  it('an authorization for the wrong amount is a mismatch: not captured, and the order can still expire', async () => {
    const { order, init } = await pending(59_000);
    const odd = ctx.razorpay.pay(init.providerOrderId, 'authorized', {
      amount: 5_000,
    });
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.authorized', odd),
    );
    expect(res.body.data.outcome).toBe('mismatch');
    expect((await shop.dbOrder(order.id)).payments[0]!.status).not.toBe(
      'AUTHORIZED',
    );
    await ctx.prisma.order.update({
      where: { id: order.id },
      data: { paymentExpiresAt: new Date(Date.now() - 60_000) },
    });
    await ctx.worker.expireUnpaidOrders();
    expect(await status(order.id)).toBe('CANCELLED');
  });

  it('a retry inside the checkout after a FAILED attempt (same provider order) is authorized, captured and paid', async () => {
    const { order, init } = await pending();
    const failed = ctx.razorpay.pay(init.providerOrderId, 'failed');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.failed', failed));
    expect(await status(order.id)).toBe('PAYMENT_FAILED');
    expect((await shop.dbOrder(order.id)).payments[0]!.status).toBe('FAILED');

    const retry = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.authorized', retry),
    );
    expect(res.body.data.outcome).toBe('authorized');
    expect(ctx.razorpay.payments.get(retry.id)!.status).toBe('captured');
    expect(await status(order.id)).toBe('PAID');
  });

  it('captures only ONE of two authorizations on the same provider order', async () => {
    const { order, init } = await pending();
    const a = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    const b = ctx.razorpay.pay(init.providerOrderId, 'authorized');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.authorized', a));
    const states = [a, b].map((p) => ctx.razorpay.payments.get(p.id)!.status);
    expect(states.filter((x) => x === 'captured')).toHaveLength(1);
    expect(await status(order.id)).toBe('PAID');
  });

  it('never captures an authorization for an unexpected amount', async () => {
    const { order, init } = await pending(59_000);
    const odd = ctx.razorpay.pay(init.providerOrderId, 'authorized', {
      amount: 5_000,
    });
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.authorized', odd));
    expect(ctx.razorpay.payments.get(odd.id)!.status).toBe('authorized');
    expect(await status(order.id)).not.toBe('PAID');
  });
});

describe('money arriving for an order we can no longer fulfil', () => {
  it('LATE CAPTURE after cancellation: the customer is refunded in full, automatically, and no goods are committed', async () => {
    const { u, order, variant, init } = await pending(59_000);
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({});
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured'); // customer paid in another tab after cancelling
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.captured', p),
    );
    expect(res.body.data.outcome).toBe('refunded_late');

    const db = await shop.dbOrder(order.id);
    expect(db.status).toBe('CANCELLED');
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({
      kind: 'LATE_CAPTURE',
      amountMinor: 59_000,
      status: 'PROCESSED',
    });
    expect(ctx.razorpay.payments.get(p.id)!.amount_refunded).toBe(59_000); // the money really went back
    expect(db.payments[0]).toMatchObject({
      status: 'REFUNDED',
      capturedMinor: 59_000,
      refundedMinor: 59_000,
    });
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
  });

  it('payment after the hold lapsed but stock still free: re-reserved and the order is PAID', async () => {
    const { order, variant, init } = await pending();
    await ctx.prisma.inventoryReservation.updateMany({
      where: { referenceId: order.id },
      data: {
        createdAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await ctx.app
      .get(
        (await import('../../src/modules/inventory/inventory.service.js'))
          .InventoryService,
      )
      .expireDue();
    expect(await shop.stock(variant.id)).toMatchObject({ reserved: 0 });
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    expect(
      (await shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', p)))
        .body.data.outcome,
    ).toBe('captured');
    expect(await status(order.id)).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
  });

  it('payment after the hold lapsed AND the stock is gone: order cancelled and the customer refunded in full', async () => {
    const { order, variant, init } = await pending(59_000, 1);
    await ctx.prisma.inventoryReservation.updateMany({
      where: { referenceId: order.id },
      data: {
        createdAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await ctx.app
      .get(
        (await import('../../src/modules/inventory/inventory.service.js'))
          .InventoryService,
      )
      .expireDue();
    await ctx.prisma.inventory.updateMany({
      where: { variantId: variant.id },
      data: { onHand: 0 },
    }); // sold elsewhere
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    const res = await shop.webhook(
      ctx.razorpay.paymentWebhook('payment.captured', p),
    );
    expect(res.body.data.outcome).toBe('refunded_out_of_stock');
    const db = await shop.dbOrder(order.id);
    expect(db.status).toBe('CANCELLED');
    expect(db.refunds[0]).toMatchObject({
      amountMinor: 59_000,
      status: 'PROCESSED',
    });
    expect(ctx.razorpay.payments.get(p.id)!.amount_refunded).toBe(59_000);
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 0,
      reserved: 0,
    }); // nothing oversold
  });
});

describe('reconciliation (missed webhooks)', () => {
  it('the worker finds a payment whose webhook never arrived and completes the order', async () => {
    const { order, variant, init } = await pending();
    ctx.razorpay.pay(init.providerOrderId, 'captured'); // no webhook is ever delivered
    await ctx.prisma.payment.updateMany({
      where: { orderId: order.id },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    expect(await ctx.worker.reconcilePayments()).toBeGreaterThanOrEqual(1);
    expect(await status(order.id)).toBe('PAID');
    expect(await shop.stock(variant.id)).toMatchObject({
      onHand: 4,
      reserved: 0,
    });
  });

  it('detects a payment made after the order was cancelled and refunds it', async () => {
    const { u, order, init } = await pending(59_000);
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({});
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured'); // webhook lost
    await ctx.prisma.payment.updateMany({
      where: { orderId: order.id },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await ctx.worker.reconcilePayments();
    expect(ctx.razorpay.payments.get(p.id)!.amount_refunded).toBe(59_000);
    expect((await shop.dbOrder(order.id)).status).toBe('CANCELLED');
  });
});

describe('payment ledgers are immutable', () => {
  it('payment events and order history cannot be edited or deleted, even by the application role', async () => {
    const { order, init } = await pending();
    ctx.razorpay.pay(init.providerOrderId, 'captured');
    const p = ctx.razorpay.pay(init.providerOrderId, 'captured');
    await shop.webhook(ctx.razorpay.paymentWebhook('payment.captured', p));
    const payment = (await shop.dbOrder(order.id)).payments[0]!;
    await expect(
      ctx.prisma.paymentEvent.updateMany({
        where: { paymentId: payment.id },
        data: { type: 'x' },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.paymentEvent.deleteMany({ where: { paymentId: payment.id } }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.orderStatusHistory.deleteMany({
        where: { orderId: order.id },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.payment.deleteMany({ where: { id: payment.id } }),
    ).rejects.toThrow();
  });

  it('the database itself refuses a second live payment for an order, and captured > amount', async () => {
    const { order } = await pending();
    await expect(
      ctx.prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'razorpay',
          amountMinor: 100,
          attempt: 9,
        },
      }),
    ).rejects.toThrow();
    const live = (await shop.dbOrder(order.id)).payments[0]!;
    await expect(
      ctx.prisma.payment.update({
        where: { id: live.id },
        data: { capturedMinor: live.amountMinor + 1 },
      }),
    ).rejects.toThrow();
  });
});
