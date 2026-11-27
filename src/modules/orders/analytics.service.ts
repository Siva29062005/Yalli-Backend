import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ReportingDb } from '../../infrastructure/database/reporting-db.js';
import {
  REPORT_TZ,
  resolveRange,
  type ReportRange,
} from './analytics-range.js';

/** Postgres SUMs come back as bigint; money in this system always fits a safe integer, and we assert it. */
const n = (v: bigint | number | null | undefined): number => {
  const x = Number(v ?? 0);
  if (!Number.isSafeInteger(x)) throw new RangeError('amount out of range');
  return x;
};

/** Average rounded half-up using integer maths. */
export const averageMinor = (totalMinor: number, count: number): number =>
  count === 0 ? 0 : Math.floor((2 * totalMinor + count) / (2 * count));

const startOf = (d: string) =>
  Prisma.sql`((${d}::date)::timestamp AT TIME ZONE ${REPORT_TZ})`;
const endOf = (d: string) =>
  Prisma.sql`(((${d}::date + 1)::timestamp) AT TIME ZONE ${REPORT_TZ})`;
const between = (col: Prisma.Sql, r: ReportRange) =>
  Prisma.sql`${col} >= ${startOf(r.from)} AND ${col} < ${endOf(r.to)}`;

/** Sort keys map to FIXED fragments: user input never reaches ORDER BY. */
const TOP_ORDER: Record<'revenue' | 'units', Prisma.Sql> = {
  revenue: Prisma.sql`revenue DESC, units DESC, product_id`,
  units: Prisma.sql`units DESC, revenue DESC, product_id`,
};

/**
 * Read-only store reports. Definitions (kept deliberately simple and stated in the API):
 *  - an order COUNTS when it has been paid (`paid_at`) in the period, whatever happened to it afterwards;
 *  - gross = sum of order totals; refunded = PROCESSED refunds in the period; net = gross - refunded;
 *  - all days are India calendar days.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: ReportingDb) {}

  async overview(from?: string, to?: string) {
    const r = resolveRange(from, to);
    const [[paid], [refunds], byStatus] = await Promise.all([
      this.db.client.$queryRaw<
        {
          orders: number;
          buyers: number;
          gross: bigint;
          discount: bigint;
          shipping: bigint;
          gst: bigint;
        }[]
      >`SELECT count(*)::int AS orders, count(DISTINCT user_id)::int AS buyers,
               COALESCE(SUM(total_minor), 0)::bigint AS gross,
               COALESCE(SUM(discount_minor), 0)::bigint AS discount,
               COALESCE(SUM(shipping_minor), 0)::bigint AS shipping,
               COALESCE(SUM(gst_included_minor), 0)::bigint AS gst
        FROM orders WHERE ${between(Prisma.sql`paid_at`, r)}`,
      this.db.client.$queryRaw<{ count: number; amount: bigint }[]>`
        SELECT count(*)::int AS count, COALESCE(SUM(amount_minor), 0)::bigint AS amount
        FROM refunds WHERE status = 'PROCESSED' AND ${between(Prisma.sql`processed_at`, r)}`,
      this.db.client.$queryRaw<{ status: string; count: number }[]>`
        SELECT status::text AS status, count(*)::int AS count
        FROM orders WHERE status <> 'CREATED' AND ${between(Prisma.sql`placed_at`, r)}
        GROUP BY status ORDER BY status`,
    ]);
    const orders = paid?.orders ?? 0;
    const gross = n(paid?.gross);
    const refunded = n(refunds?.amount);
    return {
      range: r,
      timezone: REPORT_TZ,
      currency: 'INR',
      paidOrders: orders,
      uniqueBuyers: paid?.buyers ?? 0,
      grossMinor: gross,
      refundedMinor: refunded,
      refundCount: refunds?.count ?? 0,
      netMinor: gross - refunded,
      averageOrderValueMinor: averageMinor(gross, orders),
      discountMinor: n(paid?.discount),
      shippingMinor: n(paid?.shipping),
      gstIncludedMinor: n(paid?.gst),
      ordersPlacedByStatus: Object.fromEntries(
        byStatus.map((s) => [s.status, s.count]),
      ),
    };
  }

  async salesByDay(from?: string, to?: string) {
    const r = resolveRange(from, to);
    const rows = await this.db.client.$queryRaw<
      { day: string; orders: number; gross: bigint }[]
    >`WITH days AS (
        SELECT generate_series(${r.from}::date, ${r.to}::date, interval '1 day')::date AS d),
      s AS (
        SELECT (paid_at AT TIME ZONE ${REPORT_TZ})::date AS d, count(*)::int AS orders, SUM(total_minor)::bigint AS gross
        FROM orders WHERE ${between(Prisma.sql`paid_at`, r)} GROUP BY 1)
      SELECT days.d::text AS day, COALESCE(s.orders, 0)::int AS orders, COALESCE(s.gross, 0)::bigint AS gross
      FROM days LEFT JOIN s ON s.d = days.d ORDER BY days.d`;
    return {
      range: r,
      timezone: REPORT_TZ,
      currency: 'INR',
      days: rows.map((x) => ({
        date: x.day,
        paidOrders: x.orders,
        grossMinor: n(x.gross),
      })),
    };
  }

  async topProducts(
    from: string | undefined,
    to: string | undefined,
    limit: number,
    by: 'revenue' | 'units',
  ) {
    const r = resolveRange(from, to);
    const rows = await this.db.client.$queryRaw<
      { product_id: string; name: string; units: number; revenue: bigint }[]
    >`SELECT oi.product_id, MAX(oi.product_name) AS name,
             SUM(oi.quantity)::int AS units, SUM(oi.line_total_minor)::bigint AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${between(Prisma.sql`o.paid_at`, r)}
      GROUP BY oi.product_id
      ORDER BY ${TOP_ORDER[by]}
      LIMIT ${limit}`;
    return {
      range: r,
      by,
      currency: 'INR',
      products: rows.map((p) => ({
        productId: p.product_id,
        name: p.name,
        units: p.units,
        revenueMinor: n(p.revenue),
      })),
    };
  }

  /**
   * GST on orders PAID in the period, by rate, split CGST/SGST/IGST as recorded on each order line, delivery included
   * (a delivery charge is taxed with the goods it carries). Credit notes ISSUED in the period are reported by rate too,
   * and `net` = invoiced - credited, which is what the period's GST return is based on.
   */
  async gstSummary(from?: string, to?: string) {
    const r = resolveRange(from, to);
    type Row = {
      rate: number;
      taxable: bigint;
      cgst: bigint;
      sgst: bigint;
      igst: bigint;
      total: bigint;
    };
    const [invoiced, credited, [notes]] = await Promise.all([
      this.db.client.$queryRaw<Row[]>`SELECT oi.gst_rate_bps AS rate,
             SUM(oi.line_total_minor - oi.gst_included_minor + oi.shipping_share_minor - oi.shipping_gst_minor)::bigint AS taxable,
             SUM(oi.cgst_minor + oi.shipping_cgst_minor)::bigint AS cgst,
             SUM(oi.sgst_minor + oi.shipping_sgst_minor)::bigint AS sgst,
             SUM(oi.igst_minor + oi.shipping_igst_minor)::bigint AS igst,
             SUM(oi.gst_included_minor + oi.shipping_gst_minor)::bigint AS total
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${between(Prisma.sql`o.paid_at`, r)}
      GROUP BY oi.gst_rate_bps ORDER BY oi.gst_rate_bps`,
      this.db.client.$queryRaw<Row[]>`SELECT l.gst_rate_bps AS rate,
             SUM(l.taxable_value_minor)::bigint AS taxable,
             SUM(l.cgst_minor)::bigint AS cgst, SUM(l.sgst_minor)::bigint AS sgst, SUM(l.igst_minor)::bigint AS igst,
             SUM(l.cgst_minor + l.sgst_minor + l.igst_minor)::bigint AS total
      FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id
      WHERE ${between(Prisma.sql`c.issued_at`, r)}
      GROUP BY l.gst_rate_bps ORDER BY l.gst_rate_bps`,
      this.db.client.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM credit_notes c WHERE ${between(Prisma.sql`c.issued_at`, r)}`,
    ]);
    const shape = (rows: Row[]) =>
      rows.map((x) => ({
        rateBps: x.rate,
        taxableValueMinor: n(x.taxable),
        cgstMinor: n(x.cgst),
        sgstMinor: n(x.sgst),
        igstMinor: n(x.igst),
        totalGstMinor: n(x.total),
      }));
    type Line = ReturnType<typeof shape>[number];
    const keys = [
      'taxableValueMinor',
      'cgstMinor',
      'sgstMinor',
      'igstMinor',
      'totalGstMinor',
    ] as const;
    const totalsOf = (rows: Line[]) =>
      Object.fromEntries(
        keys.map((k) => [k, rows.reduce((a, b) => a + b[k], 0)]),
      ) as Record<(typeof keys)[number], number>;
    const byRate = shape(invoiced);
    const creditByRate = shape(credited);
    const totals = totalsOf(byRate);
    const creditTotals = totalsOf(creditByRate);
    return {
      range: r,
      timezone: REPORT_TZ,
      currency: 'INR',
      byRate,
      totals,
      creditNotes: {
        count: notes?.count ?? 0,
        byRate: creditByRate,
        totals: creditTotals,
      },
      net: Object.fromEntries(
        keys.map((k) => [k, totals[k] - creditTotals[k]]),
      ) as Record<(typeof keys)[number], number>,
      notes: [
        'Invoiced: orders paid in the period, delivery charges included (taxed at the rate of the goods they carry).',
        'Credit notes: issued in the period for processed refunds. Net = invoiced minus credit notes.',
      ],
    };
  }
}
