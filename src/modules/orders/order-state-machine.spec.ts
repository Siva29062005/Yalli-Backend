import type {
  OrderStatus,
  PaymentStatus,
} from '../../generated/prisma/client.js';
import {
  assertPaymentTransition,
  canTransitionPayment,
  PAYMENT_TRANSITIONS,
} from '../payments/payment-state-machine.js';
import {
  assertOrderTransition,
  canTransitionOrder,
  InvalidTransitionError,
  ORDER_TRANSITIONS,
  PAID_CANCELLABLE,
  REFUNDABLE,
  UNPAID_CANCELLABLE,
} from './order-state-machine.js';

const ORDER_STATES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];
const PAYMENT_STATES = Object.keys(PAYMENT_TRANSITIONS) as PaymentStatus[];

function reachable<T extends string>(
  table: Record<T, readonly T[]>,
  start: T,
): Set<T> {
  const seen = new Set<T>([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of table[queue.shift()!]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('order state machine', () => {
  it('every state is reachable from CREATED (no dead or orphan states)', () => {
    expect([...reachable(ORDER_TRANSITIONS, 'CREATED')].sort()).toEqual(
      [...ORDER_STATES].sort(),
    );
  });
  it('REFUNDED and CANCELLED are terminal', () => {
    expect(ORDER_TRANSITIONS.REFUNDED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });
  it('the happy path is legal, step by step', () => {
    const path: OrderStatus[] = [
      'CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_PENDING',
      'PAID',
      'PROCESSING',
      'SHIPPED',
      'DELIVERED',
    ];
    for (let i = 0; i < path.length - 1; i++)
      expect(canTransitionOrder(path[i]!, path[i + 1]!)).toBe(true);
  });

  // The transitions that would cost money or create fraud if they were allowed.
  it.each<[OrderStatus, OrderStatus]>([
    ['CREATED', 'PAID'],
    ['INVENTORY_RESERVED', 'PAID'],
    ['PAYMENT_PENDING', 'SHIPPED'],
    ['PAID', 'DELIVERED'],
    ['PAID', 'SHIPPED'],
    ['PAID', 'CANCELLED'],
    ['PROCESSING', 'CANCELLED'],
    ['SHIPPED', 'CANCELLED'],
    ['SHIPPED', 'REFUND_PENDING'],
    ['DELIVERED', 'CANCELLED'],
    ['CANCELLED', 'PAID'],
    ['CANCELLED', 'PAYMENT_PENDING'],
    ['REFUNDED', 'PAID'],
    ['REFUNDED', 'REFUND_PENDING'],
    ['PAID', 'PAYMENT_PENDING'],
    ['DELIVERED', 'PAID'],
    ['SHIPPED', 'PROCESSING'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionOrder(from, to)).toBe(false);
    expect(() => assertOrderTransition(from, to)).toThrow(
      InvalidTransitionError,
    );
  });

  it('nothing can move backwards out of PAID except into a refund', () => {
    expect(ORDER_TRANSITIONS.PAID).toEqual(['PROCESSING', 'REFUND_PENDING']);
  });
  it('orders can only become PAID from a payment state', () => {
    const into = ORDER_STATES.filter(
      (s) => ORDER_TRANSITIONS[s].includes('PAID') && s !== 'REFUND_PENDING',
    );
    expect(into.sort()).toEqual(['PAYMENT_FAILED', 'PAYMENT_PENDING']);
  });
  it('unpaid-cancellable states can all reach CANCELLED; paid ones must go through a refund instead', () => {
    for (const s of UNPAID_CANCELLABLE)
      expect(canTransitionOrder(s, 'CANCELLED')).toBe(true);
    for (const s of PAID_CANCELLABLE) {
      expect(canTransitionOrder(s, 'CANCELLED')).toBe(false);
      expect(canTransitionOrder(s, 'REFUND_PENDING')).toBe(true);
    }
    for (const s of REFUNDABLE) expect(ORDER_STATES).toContain(s);
  });
});

describe('payment state machine', () => {
  it('captured money can only move into refund states', () => {
    expect(PAYMENT_TRANSITIONS.CAPTURED).toEqual([
      'REFUND_PENDING',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
    ]);
    for (const bad of [
      'PENDING',
      'FAILED',
      'CANCELLED',
      'CREATED',
      'AUTHORIZED',
    ] as PaymentStatus[])
      expect(canTransitionPayment('CAPTURED', bad)).toBe(false);
  });
  it('REFUNDED is terminal', () => {
    expect(PAYMENT_TRANSITIONS.REFUNDED).toEqual([]);
  });
  it('a late capture is legal from FAILED/CANCELLED (the provider order was paid after we gave up)', () => {
    expect(canTransitionPayment('FAILED', 'CAPTURED')).toBe(true);
    expect(canTransitionPayment('CANCELLED', 'CAPTURED')).toBe(true);
  });
  it('a payment can never un-capture or be captured twice', () => {
    expect(canTransitionPayment('CAPTURED', 'CAPTURED')).toBe(false);
    expect(() => assertPaymentTransition('CAPTURED', 'PENDING')).toThrow(
      InvalidTransitionError,
    );
  });
  it('every state is reachable from CREATED', () => {
    expect([...reachable(PAYMENT_TRANSITIONS, 'CREATED')].sort()).toEqual(
      [...PAYMENT_STATES].sort(),
    );
  });
});
