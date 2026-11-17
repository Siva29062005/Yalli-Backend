import {
  allocateProportionally,
  couponDiscount,
  priceCart,
  type CouponRule,
  type PricingLine,
} from './cart-pricing.js';
import { divRoundHalfUp, formatInr } from './money.js';
import { effectivePrice } from './price.js';

const line = (over: Partial<PricingLine> = {}): PricingLine => ({
  key: 'v1',
  productId: 'p1',
  categoryIds: ['kitchen'],
  unitPriceMinor: 59_000,
  quantity: 1,
  gstRateBps: 1800,
  ...over,
});
const rule = (over: Partial<CouponRule> = {}): CouponRule => ({
  code: 'SAVE10',
  discountType: 'PERCENTAGE',
  percentBps: 1000,
  amountMinor: null,
  maxDiscountMinor: null,
  scope: 'ALL_ITEMS',
  productIds: new Set(),
  categoryIds: new Set(),
  minCartMinor: 0,
  ...over,
});

describe('money helpers', () => {
  it('rounds halves up using integers only', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 2)).toBe(2);
    expect(divRoundHalfUp(1, 3)).toBe(0);
    expect(divRoundHalfUp(2, 3)).toBe(1);
  });
  it('rejects floats, negatives and unsafe numbers', () => {
    expect(() => priceCart([line({ unitPriceMinor: 590.5 })])).toThrow(
      RangeError,
    );
    expect(() => priceCart([line({ unitPriceMinor: -1 })])).toThrow(RangeError);
    expect(() => priceCart([line({ quantity: 0 })])).toThrow(RangeError);
    expect(() => priceCart([line({ quantity: 1.5 })])).toThrow(RangeError);
    expect(() =>
      priceCart([
        line({ unitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 2 }),
      ]),
    ).toThrow(RangeError);
  });
  it('formats rupees for humans', () => {
    expect(formatInr(123_456_789)).toBe('₹12,34,567.89');
    expect(formatInr(5)).toBe('₹0.05');
  });
});

describe('effectivePrice', () => {
  const base = {
    priceMinor: 59_000,
    salePriceMinor: 49_000,
    saleStartsAt: null,
    saleEndsAt: null,
  };
  it('uses the sale price when the sale is active and shows the struck-through price', () => {
    expect(effectivePrice(base)).toEqual({
      unitPriceMinor: 49_000,
      compareAtMinor: 59_000,
      onSale: true,
    });
  });
  it('ignores a sale outside its window (start inclusive, end exclusive)', () => {
    const now = new Date('2026-11-16T10:00:00Z');
    expect(
      effectivePrice(
        { ...base, saleStartsAt: new Date('2026-11-17T00:00:00Z') },
        now,
      ).onSale,
    ).toBe(false);
    expect(effectivePrice({ ...base, saleEndsAt: now }, now).onSale).toBe(
      false,
    );
    expect(effectivePrice({ ...base, saleStartsAt: now }, now).onSale).toBe(
      true,
    );
  });
  it('never treats a "sale" at or above the list price as a sale', () => {
    expect(
      effectivePrice({ ...base, salePriceMinor: 59_000 }).unitPriceMinor,
    ).toBe(59_000);
  });
});

describe('priceCart', () => {
  it('prices a simple cart and extracts the included 18% GST', () => {
    const r = priceCart([line({ unitPriceMinor: 59_000, quantity: 2 })]);
    expect(r.subtotalMinor).toBe(118_000);
    expect(r.totalMinor).toBe(118_000);
    // 118000 * 18 / 118 = 18000 exactly
    expect(r.gstIncludedMinor).toBe(18_000);
    expect(r.discountMinor).toBe(0);
    expect(r.coupon).toBeNull();
  });

  it('percentage coupons round DOWN and respect the cap', () => {
    expect(couponDiscount(rule({ percentBps: 1000 }), 12_345)).toBe(1_234);
    expect(
      couponDiscount(
        rule({ percentBps: 5000, maxDiscountMinor: 10_000 }),
        100_000,
      ),
    ).toBe(10_000);
  });

  it('a fixed coupon can never discount more than the eligible items cost', () => {
    const r = priceCart(
      [line({ unitPriceMinor: 9_900 })],
      rule({
        discountType: 'FIXED_AMOUNT',
        percentBps: null,
        amountMinor: 50_000,
      }),
    );
    expect(r.discountMinor).toBe(9_900);
    expect(r.totalMinor).toBe(0);
  });

  it('honours the minimum cart value', () => {
    const r = priceCart(
      [line({ unitPriceMinor: 10_000 })],
      rule({ minCartMinor: 50_000 }),
    );
    expect(r.couponRejection).toBe('MIN_CART_VALUE');
    expect(r.discountMinor).toBe(0);
    expect(r.coupon).toBeNull();
  });

  it('applies product- and category-scoped coupons only to eligible lines', () => {
    const lines = [
      line({
        key: 'a',
        productId: 'p1',
        categoryIds: ['kitchen'],
        unitPriceMinor: 10_000,
      }),
      line({
        key: 'b',
        productId: 'p2',
        categoryIds: ['garden'],
        unitPriceMinor: 30_000,
      }),
    ];
    const byProduct = priceCart(
      lines,
      rule({
        scope: 'PRODUCTS',
        productIds: new Set(['p2']),
        percentBps: 1000,
      }),
    );
    expect(byProduct.lines.map((l) => l.discountMinor)).toEqual([0, 3_000]);
    const byCategory = priceCart(
      lines,
      rule({
        scope: 'CATEGORIES',
        categoryIds: new Set(['kitchen']),
        percentBps: 1000,
      }),
    );
    expect(byCategory.lines.map((l) => l.discountMinor)).toEqual([1_000, 0]);
    const none = priceCart(
      lines,
      rule({ scope: 'PRODUCTS', productIds: new Set(['p9']) }),
    );
    expect(none.couponRejection).toBe('NO_ELIGIBLE_ITEMS');
  });

  it('allocates a discount across lines exactly, to the paisa', () => {
    expect(allocateProportionally(100, [100, 100, 100])).toEqual([34, 33, 33]);
    expect(allocateProportionally(1, [5_000, 5_000])).toEqual([1, 0]);
    expect(allocateProportionally(0, [10, 20])).toEqual([0, 0]);
    expect(() => allocateProportionally(31, [10, 20])).toThrow(RangeError);
  });

  // Property test: thousands of random carts and coupons; the invariants must ALWAYS hold.
  it('invariants hold for 5,000 random carts', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const rates = [0, 500, 1200, 1800, 2800, 4000];
    for (let iter = 0; iter < 5_000; iter++) {
      const lines: PricingLine[] = Array.from(
        { length: 1 + rand(6) },
        (_, i) => ({
          key: `k${i}`,
          productId: `p${rand(4)}`,
          categoryIds: [`c${rand(3)}`],
          unitPriceMinor: 1 + rand(500_000),
          quantity: 1 + rand(10),
          gstRateBps: rates[rand(rates.length)]!,
        }),
      );
      const percent = rand(2) === 0;
      const coupon =
        rand(4) === 0
          ? null
          : rule({
              discountType: percent ? 'PERCENTAGE' : 'FIXED_AMOUNT',
              percentBps: percent ? 1 + rand(10_000) : null,
              amountMinor: percent ? null : 1 + rand(1_000_000),
              maxDiscountMinor: rand(3) === 0 ? 1 + rand(200_000) : null,
              scope: (['ALL_ITEMS', 'PRODUCTS', 'CATEGORIES'] as const)[
                rand(3)
              ]!,
              productIds: new Set([`p${rand(4)}`]),
              categoryIds: new Set([`c${rand(3)}`]),
              minCartMinor: rand(5) === 0 ? rand(3_000_000) : 0,
            });
      const r = priceCart(lines, coupon);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const ints = [
        r.subtotalMinor,
        r.discountMinor,
        r.totalMinor,
        r.gstIncludedMinor,
        ...r.lines.flatMap((l) => [
          l.subtotalMinor,
          l.discountMinor,
          l.totalMinor,
          l.gstIncludedMinor,
        ]),
      ];
      expect(ints.every((n) => Number.isSafeInteger(n) && n >= 0)).toBe(true);
      expect(sum(r.lines.map((l) => l.totalMinor))).toBe(r.totalMinor);
      expect(sum(r.lines.map((l) => l.discountMinor))).toBe(r.discountMinor);
      expect(r.totalMinor).toBe(r.subtotalMinor - r.discountMinor);
      expect(r.discountMinor).toBeLessThanOrEqual(
        sum(
          r.lines.filter((l) => l.couponEligible).map((l) => l.subtotalMinor),
        ),
      );
      for (const l of r.lines) {
        expect(l.discountMinor).toBeLessThanOrEqual(l.subtotalMinor);
        if (!l.couponEligible) expect(l.discountMinor).toBe(0);
        expect(l.gstIncludedMinor).toBeLessThanOrEqual(l.totalMinor);
      }
      if (!coupon) expect(r.discountMinor).toBe(0);
    }
  });
});
