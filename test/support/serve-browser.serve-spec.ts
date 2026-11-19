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
    await ctx.drainOutbox();

    await ctx.app.listen(PORT, '127.0.0.1');
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
        usedSteps: [step - 1, step],
        customers: { c1: c1.email, c2: c2.email, c3: c3.email, c4: c4.email },
        orders: {
          a: a.orderNumber,
          b: b.orderNumber,
          c: cOrder.orderNumber,
          d: d.orderNumber,
        },
        products: {
          steamer: steamer.product.name,
          kettle: kettle.product.name,
        },
        categoryNames: ['Kitchen and Dining', 'Home Accessories'],
      }),
    );
    while (!existsSync(STOP)) await new Promise((r) => setTimeout(r, 500));
  } finally {
    await ctx.close();
  }
}, 3_600_000);
