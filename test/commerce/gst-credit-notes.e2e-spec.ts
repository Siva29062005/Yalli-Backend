import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CreditNoteService as CreditNoteServiceRef } from '../../src/modules/orders/credit-note.service.js';
import { financialYear } from '../../src/modules/orders/tax-documents.js';
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
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
});
afterAll(() => ctx.close());
// Shipping methods are global state.
beforeEach(async () => {
  await ctx.prisma.shippingMethod.deleteMany();
  const om = await s.staff('ORDER_MANAGER');
  await ctx
    .http()
    .post('/api/v1/admin/shipping-methods')
    .set(authed(om))
    .send({
      code: 'STANDARD',
      name: 'Standard',
      baseMinor: 4_900,
      etaMinDays: 3,
      etaMaxDays: 6,
    })
    .expect(201);
});

const idem = () => `k-${randomBytes(8).toString('hex')}`;
type Line = { priceMinor: number; gstRateBps: number; quantity?: number };

/** A PAID order delivered to `state`, with the ₹49 delivery fee. */
async function paidOrder(lines: Line[], state = 'Tamil Nadu') {
  const u = await shop.customer(state);
  const variants = [];
  for (const l of lines)
    variants.push(
      (
        await shop.fx.product({
          priceMinor: l.priceMinor,
          gstRateBps: l.gstRateBps,
          stock: 20,
        })
      ).variant,
    );
  const order = await shop.order(
    u,
    variants.map((v, i) => ({
      variantId: v.id,
      quantity: lines[i]!.quantity ?? 1,
    })),
    { shippingMethodCode: 'STANDARD' },
  );
  await shop.paid(u, order.id);
  await ctx.drainOutbox();
  return { u, order, db: await shop.dbOrder(order.id) };
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const invoice = async (u: Session, orderId: string) =>
  (
    await ctx
      .http()
      .get(`/api/v1/orders/${orderId}/invoice`)
      .set(authed(u))
      .expect(200)
  ).body.data;
const notes = async (u: Session, orderId: string) =>
  (
    await ctx
      .http()
      .get(`/api/v1/orders/${orderId}/credit-notes`)
      .set(authed(u))
      .expect(200)
  ).body.data as {
    creditNoteNumber: string;
    invoiceNumber: string;
    supply: string;
    lines: {
      kind: string;
      gstRateBps: number;
      totalMinor: number;
      cgstMinor: number;
      sgstMinor: number;
      igstMinor: number;
    }[];
    totals: {
      taxableValueMinor: number;
      cgstMinor: number;
      sgstMinor: number;
      igstMinor: number;
      totalMinor: number;
    };
  }[];
const taxOf = (t: {
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
}) => t.cgstMinor + t.sgstMinor + t.igstMinor;
async function refund(
  orderId: string,
  amountMinor: number,
  reason = 'Goodwill for a late delivery',
) {
  const support = await s.staff('CUSTOMER_SUPPORT');
  const finance = await s.staff('FINANCE_MANAGER');
  const req = await ctx
    .http()
    .post('/api/v1/admin/refunds')
    .set({ ...authed(support), 'Idempotency-Key': idem() })
    .send({ orderId, amountMinor, kind: 'GOODWILL', reason })
    .expect(201);
  await ctx
    .http()
    .post(`/api/v1/admin/refunds/${req.body.data.id}/approve`)
    .set(authed(finance))
    .send({})
    .expect(200);
  await ctx.drainOutbox();
  return req.body.data.id as string;
}

describe('GST on the delivery fee (composite supply)', () => {
  it('taxes delivery at the goods rate, stores it per line, and shows it on the invoice (same state: CGST + SGST)', async () => {
    const { u, order, db } = await paidOrder([
      { priceMinor: 100_000, gstRateBps: 1800 },
    ]);
    expect(db.shippingMinor).toBe(4_900);
    const item = db.items[0]!;
    expect(item.shippingShareMinor).toBe(4_900);
    expect(item.shippingGstMinor).toBe(747); // 4900 * 18 / 118
    expect(item.shippingCgstMinor + item.shippingSgstMinor).toBe(747);
    expect(item.shippingIgstMinor).toBe(0);
    expect(db.gstIncludedMinor).toBe(item.gstIncludedMinor + 747); // the order's GST includes delivery
    const inv = await invoice(u, order.id);
    const delivery = inv.lines.filter(
      (l: { kind: string }) => l.kind === 'DELIVERY',
    );
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({
      gstRateBps: 1800,
      lineTotalMinor: 4_900,
      taxableValueMinor: 4_900 - 747,
    });
    expect(
      sum(inv.lines.map((l: { lineTotalMinor: number }) => l.lineTotalMinor)),
    ).toBe(inv.totals.totalMinor);
    expect(inv.totals.taxableValueMinor).toBe(
      inv.totals.totalMinor - inv.totals.gstIncludedMinor,
    );
  });

  it('splits delivery over mixed GST rates by value, IGST only for another state', async () => {
    const { u, order, db } = await paidOrder(
      [
        { priceMinor: 30_000, gstRateBps: 500 },
        { priceMinor: 10_000, gstRateBps: 1800 },
      ],
      'Karnataka',
    );
    expect(sum(db.items.map((i) => i.shippingShareMinor))).toBe(4_900);
    const byRate = Object.fromEntries(db.items.map((i) => [i.gstRateBps, i]));
    expect(byRate[500]!.shippingShareMinor).toBe(3_675); // 4900 * 30000 / 40000
    expect(byRate[1800]!.shippingShareMinor).toBe(1_225);
    for (const i of db.items) {
      expect(i.shippingCgstMinor + i.shippingSgstMinor).toBe(0);
      expect(i.shippingIgstMinor).toBe(i.shippingGstMinor);
    }
    const inv = await invoice(u, order.id);
    expect(inv.supply).toBe('INTER_STATE');
    expect(
      inv.lines
        .filter((l: { kind: string }) => l.kind === 'DELIVERY')
        .map((l: { gstRateBps: number }) => l.gstRateBps),
    ).toEqual([500, 1800]);
  });

  it('the quote shows the same total GST as the order it becomes', async () => {
    const u = await shop.customer();
    const { variant } = await shop.fx.product({
      priceMinor: 25_000,
      gstRateBps: 1200,
      stock: 5,
    });
    await shop.fill(u, [{ variantId: variant.id, quantity: 2 }]);
    const q = await ctx
      .http()
      .post('/api/v1/checkout/quote')
      .set(authed(u))
      .send({ addressId: u.addressId, shippingMethodCode: 'STANDARD' })
      .expect(200);
    const placed = await shop.place(u, { shippingMethodCode: 'STANDARD' });
    expect(placed.status).toBe(201);
    const db = await shop.dbOrder(placed.body.data.id);
    expect(q.body.data.totals.gstIncludedMinor).toBe(db.gstIncludedMinor);
    expect(q.body.data.totals.totalMinor).toBe(db.totalMinor);
  });

  it('the database refuses a delivery share whose tax does not add up', async () => {
    const { db } = await paidOrder([{ priceMinor: 9_900, gstRateBps: 1800 }]);
    await expect(
      ctx.prisma
        .$executeRaw`INSERT INTO order_items (id, order_id, variant_id, product_id, sku, product_name, unit_price_minor, quantity,
        line_subtotal_minor, line_total_minor, gst_rate_bps, gst_included_minor, cgst_minor, shipping_share_minor, shipping_gst_minor, shipping_cgst_minor)
        VALUES (gen_random_uuid(), ${db.id}::uuid, ${db.items[0]!.variantId}::uuid, ${db.items[0]!.productId}::uuid, 'X', 'X', 100, 1, 100, 100, 1800, 15, 15, 100, 20, 19)`,
    ).rejects.toThrow(/order_items_shipping_chk/);
  });
});

describe('credit notes', () => {
  it('cancelling a paid order refunds everything and issues ONE credit note for all of it, delivery included', async () => {
    const { u, order, db } = await paidOrder([
      { priceMinor: 30_000, gstRateBps: 500 },
      { priceMinor: 10_000, gstRateBps: 1800 },
    ]);
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({})
      .expect(200);
    await ctx.drainOutbox();
    const list = await notes(u, order.id);
    expect(list).toHaveLength(1);
    const cn = list[0]!;
    const fy = financialYear(new Date());
    expect(cn.creditNoteNumber).toMatch(new RegExp(`^CN/${fy.short}/\\d{6}$`));
    expect(cn.invoiceNumber).toBe(`INV-${db.orderNumber}`);
    expect(cn.supply).toBe('INTRA_STATE');
    expect(cn.totals.totalMinor).toBe(db.totalMinor);
    expect(taxOf(cn.totals)).toBe(db.gstIncludedMinor); // exactly the GST that was invoiced
    expect(cn.totals.igstMinor).toBe(0);
    expect(cn.lines.some((l) => l.kind === 'DELIVERY')).toBe(true);
    // a second delivery of the same event changes nothing
    const refundId = (
      await ctx.prisma.refund.findFirstOrThrow({ where: { orderId: order.id } })
    ).id;
    await ctx.prisma.$transaction((tx) =>
      ctx.app.get(CreditNoteServiceRef).issueForRefundInTx(tx, refundId),
    );
    expect(await notes(u, order.id)).toHaveLength(1);
  });

  it('a return credits the returned item at its own rate; later refunds never credit more than was invoiced', async () => {
    const { u, order, db } = await paidOrder([
      { priceMinor: 30_000, gstRateBps: 500 },
      { priceMinor: 10_000, gstRateBps: 1800 },
    ]);
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
    const kettle = db.items.find((i) => i.gstRateBps === 1800)!;
    const ret = await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/returns`)
      .set(authed(u))
      .send({
        orderItemId: kettle.id,
        quantity: 1,
        reason: 'WRONG_ITEM',
        opened: false,
      })
      .expect(201);
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
      .send({})
      .expect(200);
    await ctx
      .http()
      .post(`/api/v1/admin/refunds/${received.body.data.id}/approve`)
      .set(authed(await s.staff('FINANCE_MANAGER')))
      .send({})
      .expect(200);
    await ctx.drainOutbox();
    const [first] = await notes(u, order.id);
    expect(first!.lines).toHaveLength(1);
    expect(first!.lines[0]).toMatchObject({
      kind: 'GOODS',
      gstRateBps: 1800,
      totalMinor: kettle.lineTotalMinor,
    });
    expect(taxOf(first!.lines[0]!)).toBe(kettle.gstIncludedMinor);

    // two goodwill refunds for the rest of the order: consecutive numbers, and in total exactly the invoiced tax
    const remaining = db.totalMinor - kettle.lineTotalMinor;
    await refund(order.id, 1_234);
    await refund(order.id, remaining - 1_234);
    const all = await notes(u, order.id);
    expect(all).toHaveLength(3);
    const serials = all.map((n) => Number(n.creditNoteNumber.split('/')[2]));
    expect(serials[2]! - serials[1]!).toBe(1);
    expect(sum(all.map((n) => n.totals.totalMinor))).toBe(db.totalMinor);
    expect(sum(all.map((n) => taxOf(n.totals)))).toBe(db.gstIncludedMinor);
  });

  it('only the customer can read their credit notes; finance can list and reprint them; others cannot', async () => {
    const { u, order } = await paidOrder([
      { priceMinor: 20_000, gstRateBps: 1800 },
    ]);
    await refund(order.id, 5_000);
    const [cn] = await notes(u, order.id);
    expect(cn).toBeDefined();
    await ctx.http().get(`/api/v1/orders/${order.id}/credit-notes`).expect(401);
    await ctx
      .http()
      .get(`/api/v1/orders/${order.id}/credit-notes`)
      .set(authed(await s.session()))
      .expect(404);

    const finance = await s.staff('FINANCE_MANAGER');
    const listed = await ctx
      .http()
      .get('/api/v1/admin/credit-notes')
      .set(authed(finance))
      .expect(200);
    const row = listed.body.data.find(
      (r: { creditNoteNumber: string }) =>
        r.creditNoteNumber === cn!.creditNoteNumber,
    );
    expect(row).toBeDefined();
    const doc = await ctx
      .http()
      .get(`/api/v1/admin/credit-notes/${row.id}`)
      .set(authed(finance))
      .expect(200);
    expect(doc.body.data.creditNoteNumber).toBe(cn!.creditNoteNumber);
    const refunds = await ctx
      .http()
      .get('/api/v1/admin/refunds')
      .set(authed(finance))
      .expect(200);
    expect(
      refunds.body.data.find(
        (r: { creditNote: { creditNoteNumber: string } | null }) =>
          r.creditNote?.creditNoteNumber === cn!.creditNoteNumber,
      ),
    ).toBeDefined();
    for (const who of [await s.session(), await s.staff('ORDER_MANAGER')]) {
      await ctx
        .http()
        .get('/api/v1/admin/credit-notes')
        .set(authed(who))
        .expect(403);
      await ctx
        .http()
        .get(`/api/v1/admin/credit-notes/${row.id}`)
        .set(authed(who))
        .expect(403);
    }
  });

  it('an issued credit note can never be edited or deleted: the app role has no write access and triggers guard the rest', async () => {
    const { order } = await paidOrder([
      { priceMinor: 15_000, gstRateBps: 1800 },
    ]);
    await refund(order.id, 2_000);
    const cn = await ctx.prisma.creditNote.findFirstOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    await expect(
      ctx.prisma.creditNote.update({
        where: { id: cn.id },
        data: { totalMinor: 1 },
      }),
    ).rejects.toThrow(/permission denied for table credit_notes/);
    await expect(
      ctx.prisma.creditNote.delete({ where: { id: cn.id } }),
    ).rejects.toThrow(/permission denied for table credit_notes/);
    await expect(
      ctx.prisma.creditNoteLine.update({
        where: { id: cn.lines[0]!.id },
        data: { cgstMinor: 0 },
      }),
    ).rejects.toThrow(/permission denied for table credit_note_lines/);
    expect(
      (await ctx.prisma.creditNote.findUniqueOrThrow({ where: { id: cn.id } }))
        .totalMinor,
    ).toBe(2_000);
    // second layer, for roles that DO have write access (migrations, operators): the append-only triggers
    const triggers = await ctx.prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname IN ('credit_notes_immutable', 'credit_note_lines_immutable') ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      'credit_note_lines_immutable',
      'credit_notes_immutable',
    ]);
  });

  it('the GST summary includes delivery tax and nets the credit notes issued in the period', async () => {
    await paidOrder([{ priceMinor: 50_000, gstRateBps: 1800 }]);
    const analyst = await s.staff('FINANCE_MANAGER');
    const res = await ctx
      .http()
      .get('/api/v1/admin/analytics/gst-summary')
      .set(authed(analyst))
      .expect(200);
    const g = res.body.data;
    // invoiced GST = every paid order's goods + delivery GST in this test database
    const items = await ctx.prisma.orderItem.findMany({
      where: { order: { paidAt: { not: null } } },
    });
    expect(g.totals.totalGstMinor).toBe(
      sum(items.map((i) => i.gstIncludedMinor + i.shippingGstMinor)),
    );
    const issued = await ctx.prisma.creditNote.findMany();
    expect(g.creditNotes.count).toBe(issued.length);
    expect(g.creditNotes.totals.totalGstMinor).toBe(
      sum(issued.map((c) => c.cgstMinor + c.sgstMinor + c.igstMinor)),
    );
    expect(g.net.totalGstMinor).toBe(
      g.totals.totalGstMinor - g.creditNotes.totals.totalGstMinor,
    );
    expect(g.net.taxableValueMinor).toBe(
      g.totals.taxableValueMinor - g.creditNotes.totals.taxableValueMinor,
    );
  });
});
