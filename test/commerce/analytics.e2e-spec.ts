import { Logger } from '@nestjs/common';
import pg from 'pg';
import { ReportingDb } from '../../src/infrastructure/database/reporting-db.js';
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
let finance: Awaited<ReturnType<Scenario['staff']>>;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  finance = await s.staff('FINANCE_MANAGER');
});
afterAll(() => ctx.close());

const get = (path: string, actor: Session | null = finance) => {
  const r = ctx.http().get(`/api/v1/admin/analytics/${path}`);
  return actor ? r.set(authed(actor)) : r;
};
const W = 'from=2026-03-10&to=2026-03-12';

/** Creates a PAID order and moves its payment time to `paidAt` (a fixed past window keeps assertions exact). */
async function orderPaidAt(
  paidAtIso: string,
  opts: {
    priceMinor: number;
    quantity?: number;
    state?: string;
    name?: string;
  },
) {
  const { product, variant } = await shop.fx.product({
    priceMinor: opts.priceMinor,
    stock: 50,
    ...(opts.name ? { name: opts.name } : {}),
  });
  const u = await shop.customer(opts.state ?? 'Tamil Nadu');
  const order = await shop.order(u, [
    { variantId: variant.id, quantity: opts.quantity ?? 1 },
  ]);
  await shop.paid(u, order.id);
  const at = new Date(paidAtIso);
  await ctx.prisma.order.update({
    where: { id: order.id },
    data: { paidAt: at, placedAt: at },
  });
  return { u, order, product };
}

let cancelled: Awaited<ReturnType<typeof orderPaidAt>>;
let boundary: Awaited<ReturnType<typeof orderPaidAt>>;
beforeAll(async () => {
  // A: Mar 10, 15:30 IST. B: 19:00 UTC on Mar 10 = 00:30 IST on MAR 11 (IGST: Kerala). C: Mar 12, later refunded.
  await orderPaidAt('2026-03-10T10:00:00Z', {
    priceMinor: 100_000,
    name: 'Analytics A',
  });
  boundary = await orderPaidAt('2026-03-10T19:00:00Z', {
    priceMinor: 50_000,
    quantity: 2,
    state: 'Kerala',
    name: 'Analytics B',
  });
  cancelled = await orderPaidAt('2026-03-12T05:00:00Z', {
    priceMinor: 30_000,
    name: 'Analytics C',
  });
  await orderPaidAt('2026-02-01T05:00:00Z', {
    priceMinor: 999_00,
    name: 'Outside window',
  });
  const c = await ctx
    .http()
    .post(`/api/v1/orders/${cancelled.order.id}/cancel`)
    .set(authed(cancelled.u))
    .send({});
  expect(c.status).toBe(200);
  await ctx.prisma.refund.updateMany({
    where: { orderId: cancelled.order.id },
    data: { processedAt: new Date('2026-03-12T07:00:00Z') },
  });
});

describe('timestamps', () => {
  it('a Date is stored as the same instant whatever the database server time zone is', async () => {
    const [row] = await ctx.prisma.$queryRaw<{ epoch: bigint }[]>`
      SELECT extract(epoch FROM paid_at)::bigint AS epoch FROM orders WHERE id = ${boundary.order.id}::uuid`;
    expect(Number(row!.epoch)).toBe(Date.parse('2026-03-10T19:00:00Z') / 1000);
  });
});

describe('access', () => {
  it('requires analytics.read: anonymous 401; customers and roles without it 403', async () => {
    const customer = await shop.customer();
    const inventory = await s.staff('INVENTORY_MANAGER');
    for (const path of [
      'overview',
      'sales-by-day',
      'top-products',
      'gst-summary',
    ]) {
      expect((await get(path, null)).status).toBe(401);
      expect((await get(path, customer)).status).toBe(403);
      expect((await get(path, inventory)).status).toBe(403);
      expect((await get(path)).status).toBe(200);
    }
  });
});

describe('overview', () => {
  it('counts paid orders in the period, subtracts processed refunds, and rounds the average half-up', async () => {
    const res = await get(`overview?${W}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      range: { from: '2026-03-10', to: '2026-03-12', days: 3 },
      paidOrders: 3,
      uniqueBuyers: 3,
      grossMinor: 230_000,
      refundedMinor: 30_000,
      refundCount: 1,
      netMinor: 200_000,
      averageOrderValueMinor: 76_667, // 76666.67 -> half-up
    });
    expect(res.body.data.ordersPlacedByStatus).toMatchObject({
      PAID: 2,
      REFUNDED: 1,
    });
  });

  it('an empty period is all zeros (no division by zero)', async () => {
    const res = await get('overview?from=2020-01-01&to=2020-01-31');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      paidOrders: 0,
      grossMinor: 0,
      netMinor: 0,
      averageOrderValueMinor: 0,
      ordersPlacedByStatus: {},
    });
  });

  it('defaults to the last 30 days when no range is given', async () => {
    const res = await get('overview');
    expect(res.body.data.range.days).toBe(30);
  });
});

describe('sales by day (India calendar days)', () => {
  it('buckets by IST day, so a 00:30 IST payment belongs to the next day, and fills empty days', async () => {
    const res = await get('sales-by-day?from=2026-03-09&to=2026-03-13');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([
      { date: '2026-03-09', paidOrders: 0, grossMinor: 0 },
      { date: '2026-03-10', paidOrders: 1, grossMinor: 100_000 },
      { date: '2026-03-11', paidOrders: 1, grossMinor: 100_000 }, // 19:00 UTC on the 10th
      { date: '2026-03-12', paidOrders: 1, grossMinor: 30_000 },
      { date: '2026-03-13', paidOrders: 0, grossMinor: 0 },
    ]);
  });

  it('the period boundaries are inclusive India days', async () => {
    const only11 = await get('sales-by-day?from=2026-03-11&to=2026-03-11');
    expect(only11.body.data.days).toEqual([
      { date: '2026-03-11', paidOrders: 1, grossMinor: 100_000 },
    ]);
  });
});

describe('top products', () => {
  it('ranks by revenue (ties broken by units) or by units, with a bounded limit', async () => {
    const byRevenue = await get(`top-products?${W}`);
    expect(
      byRevenue.body.data.products.map((p: { name: string }) => p.name),
    ).toEqual([
      'Analytics B', // 100000 revenue, 2 units
      'Analytics A', // 100000 revenue, 1 unit
      'Analytics C',
    ]);
    expect(byRevenue.body.data.products[0]).toMatchObject({
      units: 2,
      revenueMinor: 100_000,
    });
    const byUnits = await get(`top-products?${W}&by=units&limit=1`);
    expect(byUnits.body.data.products).toHaveLength(1);
    expect(byUnits.body.data.products[0].name).toBe('Analytics B');
  });
});

describe('gst summary', () => {
  it('splits CGST/SGST (in-state) and IGST (other state) and the figures reconcile', async () => {
    const res = await get(`gst-summary?${W}`);
    expect(res.status).toBe(200);
    const { byRate, totals } = res.body.data;
    expect(byRate).toHaveLength(1);
    expect(byRate[0].rateBps).toBe(1800);
    // gross of the 3 paid orders is 230000; GST is included in it: 230000 * 18/118 per line, rounded half-up per line
    const lineGst = (total: number) =>
      Math.floor((total * 1800 * 2 + 11_800) / (2 * 11_800));
    const expectedGst = lineGst(100_000) + lineGst(100_000) + lineGst(30_000);
    expect(totals.totalGstMinor).toBe(expectedGst);
    expect(totals.taxableValueMinor + totals.totalGstMinor).toBe(230_000);
    expect(totals.cgstMinor + totals.sgstMinor + totals.igstMinor).toBe(
      totals.totalGstMinor,
    );
    expect(totals.igstMinor).toBe(lineGst(100_000)); // only the Kerala order
    expect(totals.cgstMinor).toBe(totals.sgstMinor);
    expect(res.body.data.notes.length).toBeGreaterThan(0);
    expect(boundary.order.id).toBeDefined();
  });
});

describe('input validation', () => {
  it('rejects bad dates, inverted and oversized ranges, unknown parameters and bad limits with 400', async () => {
    for (const q of [
      'overview?from=2026-13-01',
      'overview?from=2026-02-30&to=2026-03-01',
      'overview?from=10/03/2026',
      'overview?from=2026-03-12&to=2026-03-10',
      'overview?from=2024-01-01&to=2026-01-01',
      'overview?bogus=1',
      'top-products?by=revenue;DROP TABLE orders',
      'top-products?by=margin',
      'top-products?limit=51',
      'top-products?limit=0',
    ])
      expect((await get(q)).status, q).toBe(400);
    expect(await ctx.prisma.order.count()).toBeGreaterThan(0);
  });
});

describe('reporting database role (least privilege)', () => {
  const asReporting = async <T>(run: (c: pg.Client) => Promise<T>) => {
    const c = new pg.Client({
      connectionString: process.env['REPORTING_DATABASE_URL'],
    });
    await c.connect();
    try {
      return await run(c);
    } finally {
      await c.end();
    }
  };

  it('the reports really run as yalli_reporting, read-only', async () => {
    const db = ctx.app.get(ReportingDb).client;
    const [who] = await db.$queryRaw<{ u: string; ro: string }[]>`
      SELECT current_user::text AS u, current_setting('default_transaction_read_only') AS ro`;
    expect(who).toEqual({ u: 'yalli_reporting', ro: 'on' });
    await expect(
      db.$queryRaw`UPDATE orders SET status = status`,
    ).rejects.toThrow();
  });

  it('can aggregate the report columns', async () => {
    const r = await asReporting((c) =>
      c.query(
        'SELECT count(*)::int AS n, COALESCE(sum(total_minor), 0)::bigint AS gross FROM orders WHERE paid_at IS NOT NULL',
      ),
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('cannot read personal data, secrets or any other table', async () => {
    for (const sql of [
      'SELECT contact_email FROM orders',
      'SELECT ship_line1, ship_phone, ship_postal_code FROM orders',
      'SELECT * FROM orders',
      'SELECT * FROM order_items',
      'SELECT sku FROM order_items',
      'SELECT provider_refund_id FROM refunds',
      'SELECT reason FROM refunds',
      'SELECT password_hash FROM users',
      'SELECT email FROM users',
      'SELECT * FROM audit_logs',
      'SELECT user_agent FROM audit_logs', // the audit viewer's grant leaves the user agent out
      'SELECT * FROM refresh_tokens',
      'SELECT * FROM mfa_methods',
      'SELECT * FROM payments',
      'SELECT * FROM addresses',
    ])
      await expect(
        asReporting((c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
  });

  it('cannot write, change the schema or create objects', async () => {
    for (const sql of [
      "UPDATE orders SET status = 'CANCELLED'",
      'DELETE FROM orders',
      'INSERT INTO refunds (id) VALUES (gen_random_uuid())',
      'CREATE TABLE sneaky (id int)',
      'TRUNCATE orders',
    ])
      await expect(
        asReporting((c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied|read-only/);
  });
});
