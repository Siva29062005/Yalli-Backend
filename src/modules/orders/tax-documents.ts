import { allocateProportionally } from '../pricing/cart-pricing.js';
import { divRoundHalfUp, sumMinor } from '../pricing/money.js';
import { splitGst } from './gst.js';

/**
 * Pure GST document maths shared by the tax invoice and the credit notes. Money is integer paise; nothing here reads a
 * database, so every rule is unit-tested in tax-documents.spec.ts.
 */

/** The tax columns of one order line, as stored at checkout. */
export interface TaxedItem {
  id: string;
  productName: string;
  variantName: string | null;
  sku: string;
  hsnCode: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineDiscountMinor: number;
  lineTotalMinor: number;
  gstRateBps: number;
  gstIncludedMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  shippingShareMinor: number;
  shippingGstMinor: number;
  shippingCgstMinor: number;
  shippingSgstMinor: number;
  shippingIgstMinor: number;
}

export interface TaxLine {
  kind: 'GOODS' | 'DELIVERY';
  /** The order line it belongs to (null for a delivery charge recorded before delivery was tax-split). */
  orderItemId: string | null;
  description: string;
  sku: string | null;
  hsn: string | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxableValueMinor: number;
  gstRateBps: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  lineTotalMinor: number;
}

const describe = (i: Pick<TaxedItem, 'productName' | 'variantName'>) =>
  i.productName + (i.variantName ? ` (${i.variantName})` : '');
const pct = (bps: number) => `${bps / 100}%`;

/**
 * Invoice lines: one per item, then the delivery charge as one line per GST rate (it is part of the supply of those
 * goods). Orders placed before delivery was tax-split keep their untaxed delivery remainder as a separate line.
 */
export function invoiceLines(
  items: readonly TaxedItem[],
  orderShippingMinor: number,
): TaxLine[] {
  const goods: TaxLine[] = items.map((i) => ({
    kind: 'GOODS',
    orderItemId: i.id,
    description: describe(i),
    sku: i.sku,
    hsn: i.hsnCode,
    quantity: i.quantity,
    unitPriceMinor: i.unitPriceMinor,
    discountMinor: i.lineDiscountMinor,
    taxableValueMinor: i.lineTotalMinor - i.gstIncludedMinor,
    gstRateBps: i.gstRateBps,
    cgstMinor: i.cgstMinor,
    sgstMinor: i.sgstMinor,
    igstMinor: i.igstMinor,
    lineTotalMinor: i.lineTotalMinor,
  }));
  const byRate = new Map<number, TaxLine>();
  for (const i of items) {
    if (i.shippingShareMinor === 0) continue;
    const l = byRate.get(i.gstRateBps) ?? {
      kind: 'DELIVERY' as const,
      orderItemId: null,
      description: `Delivery charges (taxed with the goods at ${pct(i.gstRateBps)})`,
      sku: null,
      hsn: null,
      quantity: 1,
      unitPriceMinor: 0,
      discountMinor: 0,
      taxableValueMinor: 0,
      gstRateBps: i.gstRateBps,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      lineTotalMinor: 0,
    };
    l.unitPriceMinor += i.shippingShareMinor;
    l.lineTotalMinor += i.shippingShareMinor;
    l.taxableValueMinor += i.shippingShareMinor - i.shippingGstMinor;
    l.cgstMinor += i.shippingCgstMinor;
    l.sgstMinor += i.shippingSgstMinor;
    l.igstMinor += i.shippingIgstMinor;
    byRate.set(i.gstRateBps, l);
  }
  const delivery = [...byRate.values()].sort(
    (a, b) => a.gstRateBps - b.gstRateBps,
  );
  const legacy =
    orderShippingMinor - sumMinor(items.map((i) => i.shippingShareMinor));
  if (legacy > 0)
    delivery.push({
      kind: 'DELIVERY',
      orderItemId: null,
      description: 'Delivery charges (recorded before GST on delivery applied)',
      sku: null,
      hsn: null,
      quantity: 1,
      unitPriceMinor: legacy,
      discountMinor: 0,
      taxableValueMinor: legacy,
      gstRateBps: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      lineTotalMinor: legacy,
    });
  return [...goods, ...delivery];
}

// --------------------------------------------------------------------------------------------- numbering

/** The Indian financial year (1 April to 31 March, India time) a moment falls in, e.g. 2026-27 / "2627". */
export function financialYear(at: Date): { label: string; short: string } {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1; // April = month 3
  const end = String((start + 1) % 100).padStart(2, '0');
  return {
    label: `${start}-${end}`,
    short: `${String(start % 100).padStart(2, '0')}${end}`,
  };
}

/** CN/2627/000001: at most 16 characters, unique and consecutive within the financial year. */
export function creditNoteNumber(fyShort: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 999_999_999)
    throw new RangeError('credit note serial out of range');
  return `CN/${fyShort}/${String(n).padStart(6, '0')}`;
}

// --------------------------------------------------------------------------------------------- credit notes

/** What earlier credit notes already credited against each invoice line. */
export interface Credited {
  orderItemId: string | null;
  kind: 'GOODS' | 'DELIVERY';
  totalMinor: number;
  taxMinor: number;
}

interface Bucket {
  kind: 'GOODS' | 'DELIVERY';
  item: TaxedItem | null;
  rate: number;
  /** Still creditable (invoiced minus already credited). */
  total: number;
  tax: number;
}

/**
 * Splits a refund into credit-note lines against what was invoiced and not yet credited.
 * - A RETURN refund goes to the returned item's goods first; only an amount beyond that (staff override) spreads over
 *   the rest of the order.
 * - Any other refund (cancellation, goodwill, correction) spreads over the whole order, delivery included, by value.
 * - The tax in each part is proportional to the GST actually invoiced on that line (so a full refund credits exactly
 *   the invoiced tax), then split into CGST+SGST or IGST like the invoice.
 * Throws when the refund is larger than what is left to credit: that would be a bug upstream.
 */
export function creditNoteLines(input: {
  items: readonly TaxedItem[];
  orderShippingMinor: number;
  amountMinor: number;
  sameState: boolean;
  returnedItemId?: string | null;
  alreadyCredited?: readonly Credited[];
}): TaxLine[] {
  const { items, amountMinor, sameState } = input;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new RangeError('credit amount must be a positive integer of paise');
  const credited = input.alreadyCredited ?? [];
  const usedFor = (kind: Bucket['kind'], id: string | null) =>
    credited
      .filter((c) => c.kind === kind && c.orderItemId === id)
      .reduce(
        (a, c) => ({ total: a.total + c.totalMinor, tax: a.tax + c.taxMinor }),
        { total: 0, tax: 0 },
      );

  const buckets: Bucket[] = [];
  for (const i of items) {
    const g = usedFor('GOODS', i.id);
    buckets.push({
      kind: 'GOODS',
      item: i,
      rate: i.gstRateBps,
      total: i.lineTotalMinor - g.total,
      tax: i.gstIncludedMinor - g.tax,
    });
    const d = usedFor('DELIVERY', i.id);
    buckets.push({
      kind: 'DELIVERY',
      item: i,
      rate: i.gstRateBps,
      total: i.shippingShareMinor - d.total,
      tax: i.shippingGstMinor - d.tax,
    });
  }
  const legacyShipping =
    input.orderShippingMinor - sumMinor(items.map((i) => i.shippingShareMinor));
  if (legacyShipping > 0) {
    const l = usedFor('DELIVERY', null);
    buckets.push({
      kind: 'DELIVERY',
      item: null,
      rate: 0,
      total: legacyShipping - l.total,
      tax: 0,
    });
  }
  const open = buckets
    .filter((b) => b.total > 0)
    .map((b) => ({ ...b, tax: Math.max(0, Math.min(b.tax, b.total)) }));
  const left = sumMinor(open.map((b) => b.total));
  if (amountMinor > left)
    throw new RangeError(
      `refund ${amountMinor} exceeds the ${left} paise still creditable on this invoice`,
    );

  const parts = Array.from({ length: open.length }, () => 0);
  const returnedGoods = open.findIndex(
    (b) => b.kind === 'GOODS' && b.item?.id === input.returnedItemId,
  );
  let rest = amountMinor;
  if (returnedGoods >= 0) {
    parts[returnedGoods] = Math.min(rest, open[returnedGoods]!.total);
    rest -= parts[returnedGoods]!;
  }
  if (rest > 0) {
    const capacity = open.map((b, i) => b.total - parts[i]!);
    allocateProportionally(rest, capacity).forEach((p, i) => (parts[i]! += p));
  }

  const lines: TaxLine[] = [];
  open.forEach((b, i) => {
    const amount = parts[i]!;
    if (amount === 0) return;
    // amount <= total and tax <= total, so tax-in-part never exceeds the part
    const tax =
      amount === b.total ? b.tax : divRoundHalfUp(amount * b.tax, b.total);
    const split = splitGst(tax, sameState);
    lines.push({
      kind: b.kind,
      orderItemId: b.item?.id ?? null,
      description:
        b.kind === 'GOODS'
          ? describe(b.item!)
          : b.item
            ? `Delivery charges for ${describe(b.item)} (at ${pct(b.rate)})`
            : 'Delivery charges (recorded before GST on delivery applied)',
      sku: b.kind === 'GOODS' ? b.item!.sku : null,
      hsn: b.kind === 'GOODS' ? b.item!.hsnCode : null,
      quantity: 1,
      unitPriceMinor: amount,
      discountMinor: 0,
      taxableValueMinor: amount - tax,
      gstRateBps: b.rate,
      ...split,
      lineTotalMinor: amount,
    });
  });
  return lines;
}
