import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { OrderEventsConsumer } from '../../src/modules/orders/order-events.consumer.js';
import { OutboxRelay } from '../../src/modules/outbox/outbox-relay.js';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  freshIp,
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
const eventsFor = (aggregateId: string) =>
  ctx.prisma.outboxEvent.findMany({
    where: { aggregateId },
    orderBy: { createdAt: 'asc' },
  });

describe('transactional outbox', () => {
  it('an event exists if and only if the business change committed (a rolled-back checkout leaves NO events)', async () => {
    const { variant } = await shop.fx.product({ stock: 1 });
    const u: Cust = await shop.customer();
    await shop.fill(u, [{ variantId: variant.id, quantity: 1 }]);
    await ctx.prisma.inventory.updateMany({
      where: { variantId: variant.id },
      data: { onHand: 0 },
    });
    expect((await shop.place(u)).status).toBe(409);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { payload: { path: ['userId'], equals: u.userId } },
      }),
    ).toBe(0);
    expect(await ctx.prisma.order.count({ where: { userId: u.userId } })).toBe(
      0,
    );
  });

  it('publishes committed events once and in creation order, then never again', async () => {
    const { variant } = await shop.fx.product({ stock: 3 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await shop.paid(u, order.id);
    ctx.bus.clear();
    await ctx.drainOutbox();
    const mine = ctx.bus.published.filter(
      (e) =>
        e.aggregateId === order.id ||
        (e.payload['orderId'] as string) === order.id,
    );
    expect(mine.map((e) => e.type)).toEqual(
      expect.arrayContaining(['order.created', 'order.paid']),
    );
    expect(mine.findIndex((e) => e.type === 'order.created')).toBeLessThan(
      mine.findIndex((e) => e.type === 'order.paid'),
    );
    expect(mine.every((e) => e.id && e.version === 1 && e.occurredAt)).toBe(
      true,
    );
    expect(
      (await eventsFor(order.id)).every((e) => e.publishedAt !== null),
    ).toBe(true);
    ctx.bus.clear();
    await ctx.drainOutbox();
    expect(ctx.bus.published).toHaveLength(0); // nothing is republished
  });

  it('events carry ids and amounts only: no tokens, no card data, no addresses', async () => {
    const { variant } = await shop.fx.product({ stock: 3 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await shop.paid(u, order.id);
    const text =
      JSON.stringify(await eventsFor(order.id)) +
      JSON.stringify(
        await ctx.prisma.outboxEvent.findMany({
          where: { payload: { path: ['orderId'], equals: order.id } },
        }),
      );
    expect(text).not.toMatch(
      /Darga|625002|9876543210|@example\.com|signature|secret|razorpay_/i,
    );
  });

  it('a broker outage never loses an event: it backs off exponentially and delivers once the broker returns', async () => {
    const { variant } = await shop.fx.product({ stock: 3 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    ctx.bus.clear();
    ctx.bus.failPublish = new Error('broker down');
    await ctx.relay.tick();
    const failed = (await eventsFor(order.id))[0]!;
    expect(failed.publishedAt).toBeNull();
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain('broker down');
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3_000);

    await ctx.relay.tick(); // still in backoff: not retried yet
    expect((await eventsFor(order.id))[0]!.attempts).toBe(1);

    ctx.bus.failPublish = null;
    await ctx.prisma.outboxEvent.updateMany({
      where: { aggregateId: order.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await ctx.drainOutbox();
    expect((await eventsFor(order.id))[0]!.publishedAt).not.toBeNull();
    expect(ctx.bus.published.some((e) => e.aggregateId === order.id)).toBe(
      true,
    );
  });

  it('a failed event holds back the LATER events of its own aggregate only (per-aggregate order), others carry on', async () => {
    const slow = randomUUID();
    const other = randomUUID();
    const t0 = Date.now() - 60_000;
    const make = (aggregateId: string, eventType: string, offset: number) =>
      ctx.prisma.outboxEvent.create({
        data: {
          aggregateType: 'test',
          aggregateId,
          eventType,
          payload: {},
          createdAt: new Date(t0 + offset),
        },
      });
    const head = await make(slow, 'test.first', 0);
    await make(slow, 'test.second', 1);
    await make(slow, 'test.third', 2);
    await make(other, 'test.other', 3);
    // the head failed earlier and is backing off (what a failed publish leaves behind)
    await ctx.prisma.outboxEvent.update({
      where: { id: head.id },
      data: { attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    const types = () =>
      ctx.bus.published
        .filter((e) => e.aggregateId === slow || e.aggregateId === other)
        .map((e) => e.type);
    ctx.bus.clear();
    await ctx.drainOutbox();
    // the other aggregate went out; the slow one's later events did NOT overtake its failed head
    expect(types()).toEqual(['test.other']);
    // when the head's backoff is over, the aggregate goes out in order
    await ctx.prisma.outboxEvent.update({
      where: { id: head.id },
      data: { nextAttemptAt: new Date() },
    });
    ctx.bus.clear();
    await ctx.drainOutbox();
    expect(types()).toEqual(['test.first', 'test.second', 'test.third']);
  });

  it('two relay instances never publish the same event twice (claim lease with SKIP LOCKED)', async () => {
    const { variant } = await shop.fx.product({ stock: 9 });
    const users: Cust[] = await Promise.all([
      shop.customer(),
      shop.customer(),
      shop.customer(),
    ]);
    const orders = await Promise.all(
      users.map((u) => shop.order(u, [{ variantId: variant.id }])),
    );
    await ctx.drainOutbox(); // flush anything older first
    const other = new OutboxRelay(
      ctx.app.get(ConfigService),
      ctx.prisma,
      ctx.bus,
    );
    for (const u of users) await shop.paid(u, orders[users.indexOf(u)]!.id);
    ctx.bus.clear();
    await Promise.all([
      ctx.relay.tick(),
      other.tick(),
      ctx.relay.tick(),
      other.tick(),
    ]);
    await ctx.drainOutbox();
    const ids = ctx.bus.published.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate publication
    expect(
      ctx.bus.published.filter((e) => e.type === 'order.paid').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('AT-LEAST-ONCE: a redelivered event is handled ONCE by the consumer (no double "order confirmed" email)', async () => {
    const { variant } = await shop.fx.product({ stock: 3 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    ctx.bus.duplicateDeliveries = true;
    try {
      await shop.paid(u, order.id);
      ctx.notifier.clear();
      await ctx.drainOutbox();
    } finally {
      ctx.bus.duplicateDeliveries = false;
    }
    expect(
      ctx.notifier.sent.filter(
        (m) =>
          m.type === 'ORDER_CONFIRMED' && 'email' in m && m.email === u.email,
      ),
    ).toHaveLength(1);
    expect(
      await ctx.prisma.processedMessage.count({
        where: { consumer: 'notifications' },
      }),
    ).toBeGreaterThan(0);
  });

  it('a consumer failure leaves no "processed" mark, so the message is retried and handled (not lost)', async () => {
    const { variant } = await shop.fx.product({ stock: 3 });
    const u: Cust = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id }]);
    await shop.paid(u, order.id);
    const consumer = ctx.app.get(OrderEventsConsumer);
    const event = {
      id: randomUUID(),
      type: 'order.paid',
      version: 1,
      aggregateType: 'order',
      aggregateId: order.id,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      payload: { orderId: order.id },
    };
    const realSend = ctx.notifier.send.bind(ctx.notifier);
    let failures = 1;
    ctx.notifier.send = (m) =>
      failures-- > 0
        ? Promise.reject(new Error('SES unavailable'))
        : realSend(m);
    try {
      await expect(consumer.handle(event)).rejects.toThrow('SES unavailable');
      expect(
        await ctx.prisma.processedMessage.count({
          where: { consumer: 'notifications', messageId: event.id },
        }),
      ).toBe(0);
      ctx.notifier.clear();
      await consumer.handle(event); // the broker's retry
      await consumer.handle(event); // and a duplicate of that
    } finally {
      ctx.notifier.send = realSend;
    }
    expect(
      ctx.notifier.sent.filter((m) => m.type === 'ORDER_CONFIRMED'),
    ).toHaveLength(1);
  });

  it('reports a backlog of old unpublished events for alerting', async () => {
    await ctx.drainOutbox();
    await ctx.prisma.outboxEvent.create({
      data: {
        aggregateType: 'test',
        aggregateId: 'x',
        eventType: 'test.old',
        payload: {},
        createdAt: new Date(Date.now() - 3_600_000),
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect(await ctx.relay.backlog(300)).toBeGreaterThanOrEqual(1);
    await ctx.prisma.outboxEvent.deleteMany({
      where: { eventType: 'test.old' },
    });
  });
});

describe('idempotency service', () => {
  const svc = () => ctx.app.get(IdempotencyService);
  const actor = () => randomUUID();
  const key = () => `k-${randomBytes(8).toString('hex')}`;

  it('replays the stored response for the same key + request, without running the work again', async () => {
    let runs = 0;
    const [a, k] = [actor(), key()];
    const work = () => Promise.resolve({ status: 201, body: { n: ++runs } });
    const first = await svc().run(
      { scope: 't', actorId: a, key: k, request: { x: 1 } },
      work,
    );
    const second = await svc().run(
      { scope: 't', actorId: a, key: k, request: { x: 1 } },
      work,
    );
    expect(runs).toBe(1);
    expect(first).toMatchObject({ replayed: false, body: { n: 1 } });
    expect(second).toMatchObject({
      replayed: true,
      status: 201,
      body: { n: 1 },
    });
  });

  it('refuses a different request under the same key; keys are private to the actor and the scope', async () => {
    const [a, k] = [actor(), key()];
    await svc().run({ scope: 't', actorId: a, key: k, request: { x: 1 } }, () =>
      Promise.resolve({ status: 200, body: 'ok' }),
    );
    await expect(
      svc().run({ scope: 't', actorId: a, key: k, request: { x: 2 } }, () =>
        Promise.resolve({ status: 200, body: 'no' }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const otherActor = await svc().run(
      { scope: 't', actorId: actor(), key: k, request: { x: 1 } },
      () => Promise.resolve({ status: 200, body: 'mine' }),
    );
    const otherScope = await svc().run(
      { scope: 'u', actorId: a, key: k, request: { x: 1 } },
      () => Promise.resolve({ status: 200, body: 'mine too' }),
    );
    expect(otherActor).toMatchObject({ replayed: false, body: 'mine' });
    expect(otherScope).toMatchObject({ replayed: false, body: 'mine too' });
  });

  it('a request still in flight answers 409; a crashed one (stale) is taken over; a failed one can be retried', async () => {
    const [a, k] = [actor(), key()];
    let release!: () => void;
    const slow = svc().run(
      { scope: 't', actorId: a, key: k, request: {} },
      () =>
        new Promise<{ status: number; body: string }>(
          (r) => (release = () => r({ status: 200, body: 'slow' })),
        ),
    );
    await new Promise((r) => setTimeout(r, 100));
    await expect(
      svc().run({ scope: 't', actorId: a, key: k, request: {} }, () =>
        Promise.resolve({ status: 200, body: 'dup' }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    release();
    await slow;

    const [a2, k2] = [actor(), key()];
    await ctx.prisma.idempotencyRecord.create({
      data: {
        scope: 't',
        actorId: a2,
        key: k2,
        requestHash: (
          await import('../../src/modules/idempotency/idempotency.service.js')
        ).hashRequest({}),
        status: 'IN_PROGRESS',
        createdAt: new Date(Date.now() - 10 * 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect(
      await svc().run({ scope: 't', actorId: a2, key: k2, request: {} }, () =>
        Promise.resolve({ status: 200, body: 'recovered' }),
      ),
    ).toMatchObject({ body: 'recovered', replayed: false });

    const [a3, k3] = [actor(), key()];
    await expect(
      svc().run({ scope: 't', actorId: a3, key: k3, request: {} }, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(
      await svc().run({ scope: 't', actorId: a3, key: k3, request: {} }, () =>
        Promise.resolve({ status: 200, body: 'second try' }),
      ),
    ).toMatchObject({ body: 'second try', replayed: false });
  });

  it('rejects malformed keys', async () => {
    const { assertIdempotencyKey } =
      await import('../../src/modules/idempotency/idempotency.service.js');
    for (const bad of [
      undefined,
      '',
      'short',
      'has spaces in it',
      'x'.repeat(129),
      "semi;colon'quote",
    ])
      expect(() => assertIdempotencyKey(bad)).toThrow();
    expect(assertIdempotencyKey('ok-key_1234.abc:def')).toBe(
      'ok-key_1234.abc:def',
    );
  });
});

describe('authorization sweep over the commerce routes', () => {
  const ID = '0190a7c0-0000-7000-8000-000000000000';
  const adminRoutes: [string, string, object | undefined][] = [
    ['get', '/api/v1/admin/orders', undefined],
    ['get', `/api/v1/admin/orders/${ID}`, undefined],
    ['get', `/api/v1/admin/orders/${ID}/payments`, undefined],
    ['post', `/api/v1/admin/orders/${ID}/fulfilment`, { status: 'PROCESSING' }],
    ['post', `/api/v1/admin/orders/${ID}/cancel`, { reason: 'because' }],
    ['get', '/api/v1/admin/returns', undefined],
    ['post', `/api/v1/admin/returns/${ID}/decision`, { decision: 'APPROVED' }],
    ['post', `/api/v1/admin/returns/${ID}/received`, {}],
    ['get', '/api/v1/admin/refunds', undefined],
    [
      'post',
      '/api/v1/admin/refunds',
      { orderId: ID, amountMinor: 100, reason: 'authz probe' },
    ],
    ['post', `/api/v1/admin/refunds/${ID}/approve`, {}],
    ['post', `/api/v1/admin/refunds/${ID}/reject`, { reason: 'authz probe' }],
  ];
  const customerRoutes: [string, string, object | undefined][] = [
    ['post', '/api/v1/checkout/quote', { addressId: ID }],
    ['post', '/api/v1/checkout/orders', { addressId: ID }],
    ['get', '/api/v1/orders', undefined],
    ['get', `/api/v1/orders/${ID}`, undefined],
    ['post', `/api/v1/orders/${ID}/cancel`, {}],
    ['get', `/api/v1/orders/${ID}/invoice`, undefined],
    ['post', `/api/v1/orders/${ID}/payments`, {}],
    ['post', `/api/v1/orders/${ID}/payments/confirm`, {}],
    ['get', `/api/v1/orders/${ID}/payment-status`, undefined],
    ['post', `/api/v1/orders/${ID}/returns`, {}],
    ['get', '/api/v1/returns', undefined],
  ];
  const call = (
    method: string,
    path: string,
    body: object | undefined,
    headers: Record<string, string>,
  ) =>
    (
      ctx.http() as unknown as Record<
        string,
        (p: string) => import('supertest').Test
      >
    )[method]!(path)
      .set(headers)
      .send(body);

  it.each([...adminRoutes, ...customerRoutes])(
    '%s %s requires authentication (401)',
    async (method, path, body) => {
      expect(
        (await call(method, path, body, { 'X-Forwarded-For': freshIp() }))
          .status,
      ).toBe(401);
      expect(
        (
          await call(method, path, body, {
            Authorization: 'Bearer garbage-garbage-garbage-1',
            'X-Forwarded-For': freshIp(),
          })
        ).status,
      ).toBe(401);
    },
  );

  it('a plain customer is forbidden (403) on EVERY admin commerce route', async () => {
    const c = await s.session();
    for (const [method, path, body] of adminRoutes)
      expect(
        (await call(method, path, body, authed(c))).status,
        `${method} ${path}`,
      ).toBe(403);
  });

  it('role matrix: each staff role reaches exactly what it should and nothing more', async () => {
    const om = await s.staff('ORDER_MANAGER');
    const support = await s.staff('CUSTOMER_SUPPORT');
    const finance = await s.staff('FINANCE_MANAGER');
    const pm = await s.staff('PRODUCT_MANAGER');
    const im = await s.staff('INVENTORY_MANAGER');
    const status = async (
      who: Session,
      method: string,
      path: string,
      body?: object,
    ) => (await call(method, path, body, authed(who))).status;
    const notForbidden = (c: number) => c !== 403 && c !== 401;

    // ORDER_MANAGER: orders.read/update, no payments, no refunds
    expect(notForbidden(await status(om, 'get', '/api/v1/admin/orders'))).toBe(
      true,
    );
    expect(
      notForbidden(
        await status(om, 'post', `/api/v1/admin/orders/${ID}/fulfilment`, {
          status: 'PROCESSING',
        }),
      ),
    ).toBe(true);
    expect(await status(om, 'get', `/api/v1/admin/orders/${ID}/payments`)).toBe(
      403,
    );
    expect(await status(om, 'get', '/api/v1/admin/refunds')).toBe(403);
    // CUSTOMER_SUPPORT: orders.read, refunds.create; NOT orders.update, refunds.approve, payments.read
    expect(
      notForbidden(await status(support, 'get', '/api/v1/admin/orders')),
    ).toBe(true);
    expect(
      await status(support, 'post', `/api/v1/admin/orders/${ID}/fulfilment`, {
        status: 'PROCESSING',
      }),
    ).toBe(403);
    expect(
      await status(support, 'post', `/api/v1/admin/refunds/${ID}/approve`, {}),
    ).toBe(403);
    expect(await status(support, 'get', '/api/v1/admin/refunds')).toBe(403);
    // FINANCE_MANAGER: payments.read, refunds.create + approve; NOT orders.update
    expect(
      notForbidden(await status(finance, 'get', '/api/v1/admin/refunds')),
    ).toBe(true);
    expect(
      notForbidden(
        await status(
          finance,
          'post',
          `/api/v1/admin/refunds/${ID}/approve`,
          {},
        ),
      ),
    ).toBe(true);
    expect(
      await status(finance, 'post', `/api/v1/admin/orders/${ID}/fulfilment`, {
        status: 'PROCESSING',
      }),
    ).toBe(403);
    // PRODUCT_MANAGER / INVENTORY_MANAGER: nothing in commerce operations
    for (const who of [pm, im])
      for (const [m, p, b] of adminRoutes)
        expect(await status(who, m, p, b), `${m} ${p}`).toBe(403);
  });

  it('the webhook endpoint is NOT reachable with a user token instead of a signature, and never trusts the Authorization header', async () => {
    const admin = await s.staff('SUPER_ADMIN');
    const res = await ctx
      .http()
      .post('/api/v1/webhooks/razorpay')
      .set({ ...authed(admin), 'Content-Type': 'application/json' })
      .send('{"event":"payment.captured"}');
    expect(res.status).toBe(401);
  });
});
