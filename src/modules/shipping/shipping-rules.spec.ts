import { describe, expect, it } from 'vitest';
import {
  canMoveShipment,
  chooseShipping,
  feeFor,
  isTerminalShipment,
  SHIPMENT_STATUSES,
  shippingOptions,
  type ShippingMethodRule,
} from './shipping-rules.js';

const m = (over: Partial<ShippingMethodRule> = {}): ShippingMethodRule => ({
  code: 'STANDARD',
  name: 'Standard',
  baseMinor: 6000,
  freeAboveMinor: 99900,
  etaMinDays: 3,
  etaMaxDays: 6,
  states: [],
  sortOrder: 0,
  ...over,
});

describe('feeFor', () => {
  it('charges the base fee below the threshold and nothing at or above it', () => {
    expect(feeFor(m(), 99899)).toBe(6000);
    expect(feeFor(m(), 99900)).toBe(0);
    expect(feeFor(m(), 500000)).toBe(0);
  });
  it('never gives free shipping when there is no threshold', () => {
    expect(feeFor(m({ freeAboveMinor: null }), 10_000_000)).toBe(6000);
  });
  it('rejects non-integer or negative amounts (no floating-point money)', () => {
    expect(() => feeFor(m(), 10.5)).toThrow(RangeError);
    expect(() => feeFor(m(), -1)).toThrow(RangeError);
  });
});

describe('shippingOptions', () => {
  const methods = [
    m({
      code: 'EXPRESS',
      name: 'Express',
      baseMinor: 15000,
      freeAboveMinor: null,
      sortOrder: 1,
    }),
    m({ code: 'STANDARD', sortOrder: 0 }),
    m({
      code: 'LOCAL',
      name: 'Local',
      baseMinor: 3000,
      states: ['Tamil Nadu'],
      sortOrder: 2,
    }),
  ];
  it('lists only methods that serve the state, cheapest first', () => {
    const tn = shippingOptions(methods, {
      state: ' tamil  nadu ',
      payableMinor: 10000,
    });
    expect(tn.map((o) => o.code)).toEqual(['LOCAL', 'STANDARD', 'EXPRESS']);
    const kl = shippingOptions(methods, {
      state: 'Kerala',
      payableMinor: 10000,
    });
    expect(kl.map((o) => o.code)).toEqual(['STANDARD', 'EXPRESS']);
  });
  it('applies the free threshold per method', () => {
    const o = shippingOptions(methods, {
      state: 'Kerala',
      payableMinor: 100000,
    });
    expect(o.find((x) => x.code === 'STANDARD')).toMatchObject({
      feeMinor: 0,
      free: true,
    });
    expect(o.find((x) => x.code === 'EXPRESS')).toMatchObject({
      feeMinor: 15000,
      free: false,
    });
  });
  it('is deterministic on equal fees', () => {
    const a = [m({ code: 'B', sortOrder: 0 }), m({ code: 'A', sortOrder: 0 })];
    expect(
      shippingOptions(a, { state: 'x', payableMinor: 0 }).map((o) => o.code),
    ).toEqual(['A', 'B']);
  });
});

describe('chooseShipping', () => {
  const opts = shippingOptions(
    [
      m({ code: 'STANDARD' }),
      m({ code: 'EXPRESS', baseMinor: 15000, freeAboveMinor: null }),
    ],
    { state: 'Kerala', payableMinor: 1000 },
  );
  it('is free (and unselected) when nothing is configured', () => {
    expect(chooseShipping(0, [], undefined, 'order').kind).toBe(
      'NOT_CONFIGURED',
    );
  });
  it('blocks when methods exist but none serves the address', () => {
    expect(chooseShipping(2, [], undefined, 'order').kind).toBe('UNAVAILABLE');
  });
  it('requires an explicit choice for orders, defaults to cheapest for quotes', () => {
    expect(chooseShipping(2, opts, undefined, 'order').kind).toBe(
      'CHOICE_REQUIRED',
    );
    const q = chooseShipping(2, opts, undefined, 'quote');
    expect(q.kind === 'SELECTED' && q.option.code).toBe('STANDARD');
  });
  it('applies a single option automatically', () => {
    const one = opts.slice(0, 1);
    expect(chooseShipping(2, one, undefined, 'order').kind).toBe('SELECTED');
  });
  it('rejects a code that is not offered for this address', () => {
    expect(chooseShipping(2, opts, 'NOPE', 'order').kind).toBe('INVALID_CODE');
    expect(chooseShipping(2, opts, 'EXPRESS', 'order').kind).toBe('SELECTED');
  });
});

describe('shipment tracking transitions', () => {
  it('only moves forward', () => {
    expect(canMoveShipment('IN_TRANSIT', 'OUT_FOR_DELIVERY')).toBe(true);
    expect(canMoveShipment('OUT_FOR_DELIVERY', 'IN_TRANSIT')).toBe(false);
    expect(canMoveShipment('DELIVERY_FAILED', 'OUT_FOR_DELIVERY')).toBe(true);
  });
  it('terminal states have no exit', () => {
    for (const s of SHIPMENT_STATUSES)
      if (isTerminalShipment(s))
        for (const t of SHIPMENT_STATUSES)
          expect(canMoveShipment(s, t)).toBe(false);
    expect(isTerminalShipment('DELIVERED')).toBe(true);
    expect(isTerminalShipment('RETURNED_TO_SELLER')).toBe(true);
    expect(isTerminalShipment('IN_TRANSIT')).toBe(false);
  });
});
