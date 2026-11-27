import { priceCart } from '../pricing/cart-pricing.js';
import { splitGst } from './gst.js';
import {
  creditNoteLines,
  creditNoteNumber,
  financialYear,
  invoiceNumber,
  invoiceLines,
  type TaxedItem,
  type TaxLine,
} from './tax-documents.js';

/** Order lines exactly as checkout stores them, from the real pricing function. */
function orderItems(
  lines: { price: number; qty: number; rate: number }[],
  shipping: number,
  sameState = true,
): TaxedItem[] {
  const priced = priceCart(
    lines.map((l, i) => ({
      key: `v${i}`,
      productId: `p${i}`,
      categoryIds: [],
      unitPriceMinor: l.price,
      quantity: l.qty,
      gstRateBps: l.rate,
    })),
    null,
    shipping,
  );
  return priced.lines.map((p, i) => {
    const g = splitGst(p.gstIncludedMinor, sameState);
    const d = splitGst(p.shippingGstMinor, sameState);
    return {
      id: `item-${i}`,
      productName: `Product ${i}`,
      variantName: null,
      sku: `SKU-${i}`,
      hsnCode: '7323',
      quantity: p.quantity,
      unitPriceMinor: p.unitPriceMinor,
      lineDiscountMinor: p.discountMinor,
      lineTotalMinor: p.totalMinor,
      gstRateBps: p.gstRateBps,
      gstIncludedMinor: p.gstIncludedMinor,
      ...g,
      shippingShareMinor: p.shippingShareMinor,
      shippingGstMinor: p.shippingGstMinor,
      shippingCgstMinor: d.cgstMinor,
      shippingSgstMinor: d.sgstMinor,
      shippingIgstMinor: d.igstMinor,
    };
  });
}
const sum = (ls: TaxLine[], k: keyof TaxLine) =>
  ls.reduce((a, l) => a + (l[k] as number), 0);
const tax = (ls: TaxLine[]) =>
  sum(ls, 'cgstMinor') + sum(ls, 'sgstMinor') + sum(ls, 'igstMinor');

describe('invoice lines', () => {
  it('lists the goods, then delivery per GST rate, and adds up to the order', () => {
    const items = orderItems(
      [
        { price: 30_000, qty: 1, rate: 500 },
        { price: 10_000, qty: 2, rate: 1800 },
      ],
      4_900,
    );
    const lines = invoiceLines(items, 4_900);
    expect(lines.map((l) => l.kind)).toEqual([
      'GOODS',
      'GOODS',
      'DELIVERY',
      'DELIVERY',
    ]);
    expect(lines[2]!.description).toContain('5%');
    expect(lines[3]!.description).toContain('18%');
    expect(sum(lines, 'lineTotalMinor')).toBe(50_000 + 4_900);
    for (const l of lines)
      expect(
        l.taxableValueMinor + l.cgstMinor + l.sgstMinor + l.igstMinor,
      ).toBe(l.lineTotalMinor);
  });
  it('shows no delivery line when delivery was free, and an untaxed remainder for old orders', () => {
    const free = orderItems([{ price: 10_000, qty: 1, rate: 1800 }], 0);
    expect(invoiceLines(free, 0).filter((l) => l.kind === 'DELIVERY')).toEqual(
      [],
    );
    const legacy = invoiceLines(free, 4_900); // shipping charged, but stored before the split existed
    expect(legacy.at(-1)).toMatchObject({
      kind: 'DELIVERY',
      lineTotalMinor: 4_900,
      taxableValueMinor: 4_900,
      gstRateBps: 0,
    });
  });
});

describe('credit note lines', () => {
  const items = orderItems(
    [
      { price: 30_000, qty: 1, rate: 500 },
      { price: 10_000, qty: 2, rate: 1800 },
    ],
    4_900,
  );
  const invoiceTax = tax(invoiceLines(items, 4_900));

  it('a full refund (cancellation) credits exactly what was invoiced, delivery included', () => {
    const lines = creditNoteLines({
      items,
      orderShippingMinor: 4_900,
      amountMinor: 54_900,
      sameState: true,
    });
    expect(sum(lines, 'lineTotalMinor')).toBe(54_900);
    expect(tax(lines)).toBe(invoiceTax);
    expect(lines.some((l) => l.kind === 'DELIVERY')).toBe(true);
    expect(sum(lines, 'igstMinor')).toBe(0); // same state: CGST + SGST
  });

  it('a return credits the returned item at its own rate first', () => {
    const lines = creditNoteLines({
      items,
      orderShippingMinor: 4_900,
      amountMinor: 10_000,
      sameState: false,
      returnedItemId: 'item-1',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'GOODS',
      orderItemId: 'item-1',
      gstRateBps: 1800,
      lineTotalMinor: 10_000,
    });
    // invoiced GST on that line: 20000 * 18/118 = 3050.8 -> 3051; half of the line -> 3051/2 = 1525.5 -> 1526 (half up)
    expect(lines[0]!.igstMinor).toBe(1_526);
    expect(lines[0]!.cgstMinor + lines[0]!.sgstMinor).toBe(0); // other state: IGST only
  });

  it('a partial goodwill refund spreads by value, and repeated refunds never credit more than was invoiced', () => {
    let credited: {
      orderItemId: string | null;
      kind: 'GOODS' | 'DELIVERY';
      totalMinor: number;
      taxMinor: number;
    }[] = [];
    const amounts = [7_777, 12_345, 1, 20_000, 14_777]; // adds up to the whole order (54,900)
    let totalTax = 0;
    for (const amountMinor of amounts) {
      const lines = creditNoteLines({
        items,
        orderShippingMinor: 4_900,
        amountMinor,
        sameState: true,
        alreadyCredited: credited,
      });
      expect(sum(lines, 'lineTotalMinor')).toBe(amountMinor);
      totalTax += tax(lines);
      credited = credited.concat(
        lines.map((l) => ({
          orderItemId: l.orderItemId,
          kind: l.kind,
          totalMinor: l.lineTotalMinor,
          taxMinor: l.cgstMinor + l.sgstMinor + l.igstMinor,
        })),
      );
    }
    expect(totalTax).toBe(invoiceTax); // nothing over- or under-credited in the end
    expect(() =>
      creditNoteLines({
        items,
        orderShippingMinor: 4_900,
        amountMinor: 1,
        sameState: true,
        alreadyCredited: credited,
      }),
    ).toThrow(RangeError);
  });

  it('refuses nonsense amounts', () => {
    expect(() =>
      creditNoteLines({
        items,
        orderShippingMinor: 4_900,
        amountMinor: 0,
        sameState: true,
      }),
    ).toThrow(RangeError);
    expect(() =>
      creditNoteLines({
        items,
        orderShippingMinor: 4_900,
        amountMinor: 54_901,
        sameState: true,
      }),
    ).toThrow(RangeError);
    expect(() =>
      creditNoteLines({
        items,
        orderShippingMinor: 4_900,
        amountMinor: 1.5,
        sameState: true,
      }),
    ).toThrow(RangeError);
  });
});

describe('numbering', () => {
  it('uses the Indian financial year in India time', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toEqual({
      label: '2025-26',
      short: '2526',
    }); // 23:59 IST 31 Mar
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toEqual({
      label: '2026-27',
      short: '2627',
    }); // 00:01 IST 1 Apr
    expect(financialYear(new Date('2026-11-20T10:00:00Z'))).toEqual({
      label: '2026-27',
      short: '2627',
    });
    expect(financialYear(new Date('2099-12-31T00:00:00Z'))).toEqual({
      label: '2099-00',
      short: '9900',
    });
  });
  it('formats serials within the 16-character limit', () => {
    expect(creditNoteNumber('2627', 1)).toBe('CN/2627/000001');
    expect(creditNoteNumber('2627', 1)).toHaveLength(14);
    expect(creditNoteNumber('2627', 99_999_999)).toBe('CN/2627/99999999');
    expect(creditNoteNumber('2627', 99_999_999)).toHaveLength(16);
    expect(() => creditNoteNumber('2627', 100_000_000)).toThrow(RangeError); // would be 17 characters
    expect(() => creditNoteNumber('2627', 0)).toThrow(RangeError);
  });
  it('formats invoice numbers within the 16-character GST limit', () => {
    expect(invoiceNumber('2627', 1)).toBe('INV/2627/000001');
    expect(invoiceNumber('2627', 9_999_999)).toBe('INV/2627/9999999');
    expect(invoiceNumber('2627', 9_999_999)).toHaveLength(16);
    expect(() => invoiceNumber('2627', 10_000_000)).toThrow(RangeError);
    expect(() => invoiceNumber('2627', 0)).toThrow(RangeError);
    expect(() => invoiceNumber('27', 1)).toThrow(RangeError);
  });
});
