import type { PaymentStatus } from '../../generated/prisma/client.js';
import { InvalidTransitionError } from '../orders/order-state-machine.js';

/**
 * Internal payment states. Provider-specific states are mapped onto these in the adapter.
 * CAPTURED may be reached from FAILED / CANCELLED: the provider order can still be paid after an earlier failed attempt,
 * and a customer can pay just as our expiry job cancelled the order (a "late capture", which is refunded automatically).
 * FAILED -> AUTHORIZED: a retry inside the provider's checkout (same provider order) after a failed attempt.
 */
export const PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  CREATED: ['PENDING', 'FAILED', 'CANCELLED', 'CAPTURED'],
  PENDING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  FAILED: ['PENDING', 'AUTHORIZED', 'CAPTURED', 'CANCELLED'],
  CANCELLED: ['CAPTURED'],
  REFUND_PENDING: ['PARTIALLY_REFUNDED', 'REFUNDED', 'CAPTURED'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING', 'REFUNDED'],
  REFUNDED: [],
};

export const canTransitionPayment = (
  from: PaymentStatus,
  to: PaymentStatus,
): boolean => PAYMENT_TRANSITIONS[from].includes(to);

export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  if (!canTransitionPayment(from, to))
    throw new InvalidTransitionError(from, to, 'payment');
}

/** Statuses in which money is (or may be) held and the payment counts as "live" for the one-live-payment rule. */
export const LIVE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
];
export const MONEY_HELD_STATUSES: readonly PaymentStatus[] = [
  'CAPTURED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
];
