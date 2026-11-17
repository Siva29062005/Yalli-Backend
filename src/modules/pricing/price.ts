import type { Minor } from './money.js';

export interface VariantPriceFields {
  priceMinor: number;
  salePriceMinor: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}

export interface EffectivePrice {
  /** What the customer pays per unit right now (GST-inclusive). */
  unitPriceMinor: Minor;
  /** The struck-through "was" price when a sale is active, else null. */
  compareAtMinor: Minor | null;
  onSale: boolean;
}

/** The single definition of "current price" used by catalog listings, carts and (later) checkout. */
export function effectivePrice(
  v: VariantPriceFields,
  now: Date = new Date(),
): EffectivePrice {
  const saleActive =
    v.salePriceMinor !== null &&
    v.salePriceMinor < v.priceMinor &&
    (v.saleStartsAt === null || v.saleStartsAt <= now) &&
    (v.saleEndsAt === null || now < v.saleEndsAt);
  return saleActive
    ? {
        unitPriceMinor: v.salePriceMinor!,
        compareAtMinor: v.priceMinor,
        onSale: true,
      }
    : { unitPriceMinor: v.priceMinor, compareAtMinor: null, onSale: false };
}
