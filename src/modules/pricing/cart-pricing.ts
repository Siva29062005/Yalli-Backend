import { assertMinor, divRoundHalfUp, sumMinor, type Minor } from './money.js';

export interface PricingLine {
  key: string;
  productId: string;
  categoryIds: readonly string[];
  /** Server-side effective unit price (never from the client). */
  unitPriceMinor: Minor;
  quantity: number;
  /** GST rate in basis points; prices are GST-inclusive. */
  gstRateBps: number;
}

export interface CouponRule {
  code: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  percentBps: number | null;
  amountMinor: number | null;
  maxDiscountMinor: number | null;
  scope: 'ALL_ITEMS' | 'PRODUCTS' | 'CATEGORIES';
  productIds: ReadonlySet<string>;
  categoryIds: ReadonlySet<string>;
  /** Applies to the WHOLE cart subtotal (before discount). */
  minCartMinor: number;
}

export type CouponRejection = 'MIN_CART_VALUE' | 'NO_ELIGIBLE_ITEMS';

export interface PricedLine extends PricingLine {
  subtotalMinor: Minor;
  discountMinor: Minor;
  totalMinor: Minor;
  gstIncludedMinor: Minor;
  couponEligible: boolean;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotalMinor: Minor;
  discountMinor: Minor;
  shippingMinor: Minor;
  totalMinor: Minor;
  gstIncludedMinor: Minor;
  coupon: { code: string; discountMinor: Minor } | null;
  couponRejection: CouponRejection | null;
}

export const MAX_LINE_QUANTITY = 10;

function isEligible(line: PricingLine, rule: CouponRule): boolean {
  if (rule.scope === 'ALL_ITEMS') return true;
  if (rule.scope === 'PRODUCTS') return rule.productIds.has(line.productId);
  return line.categoryIds.some((c) => rule.categoryIds.has(c));
}

/** Coupon value for an eligible subtotal. Percentages round DOWN (never over-discount); capped; never above the base. */
export function couponDiscount(
  rule: CouponRule,
  eligibleSubtotal: Minor,
): Minor {
  let d: number;
  if (rule.discountType === 'PERCENTAGE') {
    d = Math.floor((eligibleSubtotal * (rule.percentBps ?? 0)) / 10_000);
  } else {
    d = rule.amountMinor ?? 0;
  }
  if (rule.maxDiscountMinor !== null) d = Math.min(d, rule.maxDiscountMinor);
  return Math.max(0, Math.min(d, eligibleSubtotal));
}

/**
 * Splits `total` across `weights` proportionally with the largest-remainder method, so the parts are integers that
 * add up EXACTLY to the total (no paise lost or invented). Ties go to the earlier line, deterministically.
 */
export function allocateProportionally(
  total: Minor,
  weights: readonly Minor[],
): Minor[] {
  const sum = sumMinor(weights);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  if (total > sum)
    throw new RangeError('cannot allocate more than the weights');
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - sumMinor(parts);
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of remainders) {
    if (left === 0) break;
    if (parts[i]! < weights[i]!) {
      parts[i]! += 1;
      left--;
    }
  }
  return parts;
}

/**
 * Prices a cart. Pure and deterministic: given the same inputs it always yields the same paise.
 * Invariants (property-tested): sum(line totals) = total; sum(line discounts) = discount <= eligible subtotal;
 * 0 <= gstIncluded <= total; every value is a non-negative integer.
 */
export function priceCart(
  lines: readonly PricingLine[],
  coupon: CouponRule | null = null,
  shippingMinor: Minor = 0,
): PricingResult {
  for (const l of lines) {
    assertMinor(l.unitPriceMinor, 'unit price');
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1)
      throw new RangeError('quantity must be a positive integer');
    if (
      !Number.isSafeInteger(l.gstRateBps) ||
      l.gstRateBps < 0 ||
      l.gstRateBps > 4000
    )
      throw new RangeError('invalid GST rate');
  }
  assertMinor(shippingMinor, 'shipping');

  const subtotals = lines.map((l) =>
    assertMinor(l.unitPriceMinor * l.quantity, 'line subtotal'),
  );
  const subtotalMinor = sumMinor(subtotals);

  let discount = 0;
  let couponRejection: CouponRejection | null = null;
  const eligible = lines.map((l) => (coupon ? isEligible(l, coupon) : false));
  if (coupon) {
    const eligibleSubtotal = sumMinor(subtotals.filter((_, i) => eligible[i]));
    if (subtotalMinor < coupon.minCartMinor) couponRejection = 'MIN_CART_VALUE';
    else if (eligibleSubtotal === 0) couponRejection = 'NO_ELIGIBLE_ITEMS';
    else discount = couponDiscount(coupon, eligibleSubtotal);
  }

  const lineDiscounts = allocateProportionally(
    discount,
    subtotals.map((s, i) => (eligible[i] ? s : 0)),
  );

  const priced: PricedLine[] = lines.map((l, i) => {
    const total = subtotals[i]! - lineDiscounts[i]!;
    return {
      ...l,
      subtotalMinor: subtotals[i]!,
      discountMinor: lineDiscounts[i]!,
      totalMinor: total,
      // GST is INCLUDED in the price: tax = total * r / (1 + r), rounded half-up per line.
      gstIncludedMinor: divRoundHalfUp(
        total * l.gstRateBps,
        10_000 + l.gstRateBps,
      ),
      couponEligible: eligible[i]!,
    };
  });

  const itemsTotal = sumMinor(priced.map((p) => p.totalMinor));
  return {
    lines: priced,
    subtotalMinor,
    discountMinor: discount,
    shippingMinor,
    totalMinor: itemsTotal + shippingMinor,
    gstIncludedMinor: sumMinor(priced.map((p) => p.gstIncludedMinor)),
    coupon:
      coupon && couponRejection === null
        ? { code: coupon.code, discountMinor: discount }
        : null,
    couponRejection,
  };
}
