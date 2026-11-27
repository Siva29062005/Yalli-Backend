// Boots the REAL application (real PostgreSQL roles, auth, MFA, step-up, outbox) with realistic data and serves it over
// HTTP until a stop file appears. Payments use the in-process Razorpay simulator; the database is throwaway.
// Not matched by the e2e glob, so `npm run check` ignores it. Start it with `npm run serve:browser`, then run
// `frontend/scripts/test-admin-real.mjs` (it reads the info file). Create the stop file to shut it down. The seeded
// admin's TOTP steps are single-use, so restart this between browser runs.
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authed, createTestApp, Scenario, Shop } from './test-app.js';

const PORT = Number(process.env['SERVE_PORT'] ?? 3302);
const INFO =
  process.env['SERVE_INFO_FILE'] ?? join(tmpdir(), 'yalli-serve-info.json');
const STOP =
  process.env['SERVE_STOP_FILE'] ?? join(tmpdir(), 'yalli-serve.stop');

it('serves the real app for browser checks', async () => {
  const ctx = await createTestApp();
  const s = new Scenario(ctx);
  const shop = new Shop(ctx, s);
  const http = () => ctx.http();
  try {
    const admin = await s.staff('SUPER_ADMIN');
    const support = await s.staff('CUSTOMER_SUPPORT');

    const kitchen = await shop.fx.category('Kitchen and Dining');
    const home = await shop.fx.category('Home Accessories');
    const brand = await shop.fx.brand('Yalli');
    const steamer = await shop.fx.product({
      name: 'Momo Steamer 2 Tier',
      priceMinor: 79_900,
      salePriceMinor: 69_000,
      stock: 18,
      categoryIds: [kitchen.id],
      brandId: brand.id,
    });
    const kettle = await shop.fx.product({
      name: 'Slow Mornings Kettle',
      priceMinor: 179_000,
      stock: 6,
      categoryIds: [home.id],
      brandId: brand.id,
    });
    const bowls = await shop.fx.product({
      name: 'Earth Ceramic Bowl Set',
      priceMinor: 69_000,
      stock: 40,
      categoryIds: [kitchen.id],
    });

    const [c1, c2, c3, c4] = [
      await shop.customer(),
      await shop.customer('Karnataka'),
      await shop.customer(),
      await shop.customer(),
    ] as const;
    // A: paid, waiting to be packed.
    const a = await shop.order(c1, [
      { variantId: steamer.variant.id, quantity: 2 },
    ]);
    await shop.paid(c1, a.id);
    // B: paid, shipped, delivered, then the customer asks for a return.
    const b = await shop.order(c2, [{ variantId: kettle.variant.id }]);
    await shop.paid(c2, b.id);
    await ctx.drainOutbox();
    const stepFor = (id: string, body: object) =>
      http()
        .post(`/api/v1/admin/orders/${id}/fulfilment`)
        .set(authed(admin))
        .send(body)
        .expect(200);
    await stepFor(b.id, { status: 'PROCESSING' });
    await stepFor(b.id, {
      status: 'SHIPPED',
      trackingCarrier: 'Delhivery',
      trackingNumber: 'SEED-B-0001',
    });
    await stepFor(b.id, { status: 'DELIVERED' });
    const bItems = await shop.dbOrder(b.id);
    await http()
      .post(`/api/v1/orders/${b.id}/returns`)
      .set(authed(c2))
      .send({
        orderItemId: bItems.items[0]!.id,
        quantity: 1,
        reason: 'FAULTY',
        opened: true,
        details: 'Lid is cracked',
      })
      .expect(201);
    // Reviews waiting for moderation: two customers whose orders were delivered.
    const deliver = async (orderId: string) => {
      await stepFor(orderId, { status: 'PROCESSING' });
      await stepFor(orderId, {
        status: 'SHIPPED',
        trackingCarrier: 'Delhivery',
        trackingNumber: `SEED-${orderId.slice(-6)}`,
      });
      await stepFor(orderId, { status: 'DELIVERED' });
    };
    await http()
      .post(`/api/v1/catalog/products/${kettle.product.slug}/reviews`)
      .set(authed(c2))
      .send({
        rating: 4,
        title: 'Sturdy and quick',
        body: 'Boils fast and the gooseneck pours neatly.',
      })
      .expect(201);
    const c5 = await shop.customer();
    const e = await shop.order(c5, [{ variantId: bowls.variant.id }]);
    await shop.paid(c5, e.id);
    await ctx.drainOutbox();
    await deliver(e.id);
    await http()
      .post(`/api/v1/catalog/products/${bowls.product.slug}/reviews`)
      .set(authed(c5))
      .send({
        rating: 2,
        title: 'Not what I expected',
        body: 'The glaze chipped after one wash, rather disappointing.',
      })
      .expect(201);
    // C: paid, with a refund REQUEST raised by support that a second person (the admin) must approve.
    const cOrder = await shop.order(c3, [
      { variantId: bowls.variant.id, quantity: 3 },
    ]);
    await shop.paid(c3, cOrder.id);
    await http()
      .post('/api/v1/admin/refunds')
      .set({ ...authed(support), 'Idempotency-Key': 'seed-refund-1' })
      .send({
        orderId: cOrder.id,
        amountMinor: 20_000,
        kind: 'ADMIN',
        reason: 'Two bowls arrived chipped',
      })
      .expect(201);
    // D: placed but never paid (cancellable).
    const d = await shop.order(c4, [{ variantId: bowls.variant.id }]);
    // F: cancelled by the customer, but the provider REFUSED the refund (FAILED): staff retry it (Phase 11).
    const c6 = await shop.customer();
    const f = await shop.order(c6, [{ variantId: kettle.variant.id }]);
    await shop.paid(c6, f.id);
    ctx.razorpay.failNext.push({ match: '/refund', mode: 'reject' });
    await http()
      .post(`/api/v1/orders/${f.id}/cancel`)
      .set(authed(c6))
      .send({})
      .expect(200);
    // An archived product, to restore from the console.
    const archived = await shop.fx.product({
      name: 'Retired Brass Teapot',
      priceMinor: 120_000,
      stock: 0,
      categoryIds: [kitchen.id],
      status: 'ARCHIVED',
    });
    await ctx.drainOutbox();

    await ctx.app.listen(PORT, '127.0.0.1');
    // Production runs the outbox relay in the background; do the same so events (e.g. credit notes) flow.
    let draining = false;
    const relay = setInterval(() => {
      if (draining) return;
      draining = true;
      void ctx
        .drainOutbox()
        .catch(() => undefined)
        .finally(() => (draining = false));
    }, 1_000);
    const step = Math.floor(Date.now() / 30_000);
    writeFileSync(
      INFO,
      JSON.stringify({
        port: PORT,
        admin: {
          email: admin.email,
          password: admin.password,
          secret: admin.secret,
        },
        support: {
          email: support.email,
          password: support.password,
          secret: support.secret,
        },
        usedSteps: [step - 1, step],
        customers: { c1: c1.email, c2: c2.email, c3: c3.email, c4: c4.email },
        orders: {
          a: a.orderNumber,
          b: b.orderNumber,
          c: cOrder.orderNumber,
          d: d.orderNumber,
          f: f.orderNumber,
        },
        archivedProduct: archived.product.name,
        customerC1Phone: (
          await ctx.prisma.user.findUniqueOrThrow({ where: { id: c1.userId } })
        ).phoneE164,
        products: {
          steamer: steamer.product.name,
          kettle: kettle.product.name,
        },
        kettleSlug: kettle.product.slug,
        bowlsSlug: bowls.product.slug,
        categoryNames: ['Kitchen and Dining', 'Home Accessories'],
      }),
    );
    while (!existsSync(STOP)) await new Promise((r) => setTimeout(r, 500));
    clearInterval(relay);
  } finally {
    await ctx.close();
  }
}, 3_600_000);
