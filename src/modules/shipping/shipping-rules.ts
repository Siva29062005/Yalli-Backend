/**
 * Pure shipping rules (no I/O), so the money logic is unit-testable and the ONLY place a delivery fee is decided.
 * Money is integer paise. The fee never depends on anything the client sends except the chosen method CODE.
 */
export interface ShippingMethodRule {
  code: string;
  name: string;
  /** Flat fee in paise. */
  baseMinor: number;
  /** Free when the payable items total (after discount) reaches this; null = never free. */
  freeAboveMinor: number | null;
  etaMinDays: number;
  etaMaxDays: number;
  /** Indian state names served; empty = everywhere. Compared case-insensitively. */
  states: readonly string[];
  sortOrder: number;
}

export interface ShippingOption {
  code: string;
  name: string;
  feeMinor: number;
  free: boolean;
  etaMinDays: number;
  etaMaxDays: number;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function servesState(m: ShippingMethodRule, state: string): boolean {
  return m.states.length === 0 || m.states.some((s) => norm(s) === norm(state));
}

export function feeFor(m: ShippingMethodRule, payableMinor: number): number {
  if (!Number.isSafeInteger(payableMinor) || payableMinor < 0)
    throw new RangeError('payable amount must be a non-negative integer');
  return m.freeAboveMinor !== null && payableMinor >= m.freeAboveMinor
    ? 0
    : m.baseMinor;
}

/** Options for a destination, cheapest first (ties: admin sort order, then code for determinism). */
export function shippingOptions(
  methods: readonly ShippingMethodRule[],
  dest: { state: string; payableMinor: number },
): ShippingOption[] {
  return methods
    .filter((m) => servesState(m, dest.state))
    .map((m) => {
      const feeMinor = feeFor(m, dest.payableMinor);
      return {
        code: m.code,
        name: m.name,
        feeMinor,
        free: feeMinor === 0,
        etaMinDays: m.etaMinDays,
        etaMaxDays: m.etaMaxDays,
        sort: m.sortOrder,
      };
    })
    .sort(
      (a, b) =>
        a.feeMinor - b.feeMinor ||
        a.sort - b.sort ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    )
    .map(({ sort: _sort, ...o }) => o);
}

export type ShippingChoice =
  | { kind: 'NOT_CONFIGURED' } // no active methods at all: shipping is free (documented default)
  | { kind: 'UNAVAILABLE' } // methods exist but none serves this address
  | { kind: 'CHOICE_REQUIRED'; options: ShippingOption[] }
  | { kind: 'INVALID_CODE'; options: ShippingOption[] }
  | { kind: 'SELECTED'; option: ShippingOption; options: ShippingOption[] };

/**
 * Resolves which option applies. With more than one option the buyer must name one (no silent choice of a price);
 * with exactly one it is applied automatically. `quote` mode defaults to the cheapest so a preview can still show totals.
 */
export function chooseShipping(
  activeMethodCount: number,
  options: ShippingOption[],
  requestedCode: string | undefined,
  mode: 'quote' | 'order',
): ShippingChoice {
  if (activeMethodCount === 0) return { kind: 'NOT_CONFIGURED' };
  if (options.length === 0) return { kind: 'UNAVAILABLE' };
  if (requestedCode !== undefined) {
    const option = options.find((o) => o.code === requestedCode);
    return option
      ? { kind: 'SELECTED', option, options }
      : { kind: 'INVALID_CODE', options };
  }
  if (options.length === 1)
    return { kind: 'SELECTED', option: options[0]!, options };
  return mode === 'quote'
    ? { kind: 'SELECTED', option: options[0]!, options }
    : { kind: 'CHOICE_REQUIRED', options };
}

// ---------------------------------------------------------------------------------------------- tracking

export const SHIPMENT_STATUSES = [
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
  'DELIVERED',
  'RETURNED_TO_SELLER',
] as const;
export type ShipmentStatusName = (typeof SHIPMENT_STATUSES)[number];

const NEXT: Readonly<
  Record<ShipmentStatusName, readonly ShipmentStatusName[]>
> = {
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERY_FAILED', 'DELIVERED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED_TO_SELLER'],
  DELIVERED: [],
  RETURNED_TO_SELLER: [],
};

export const isTerminalShipment = (s: ShipmentStatusName) =>
  NEXT[s].length === 0;

/** A tracking update may only move forward; a repeat of the current status is an idempotent no-op. */
export function canMoveShipment(
  from: ShipmentStatusName,
  to: ShipmentStatusName,
): boolean {
  return NEXT[from].includes(to);
}
