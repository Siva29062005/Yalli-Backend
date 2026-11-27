import type { OrderStatus } from '../../generated/prisma/client.js';

/**
 * The ONLY legal order transitions. Anything else is a bug (or an attack) and is rejected, whatever called it.
 * Notes:
 *  - cancelling after payment goes through REFUND_PENDING (money must come back before the order is closed);
 *  - SHIPPED orders cannot be cancelled: they are returned after delivery;
 *  - PAYMENT_FAILED -> PAID is legal because one provider order allows several payment attempts, and a later attempt may succeed;
 *  - REFUND_PENDING may revert to the state it left (see Order.statusBeforeRefund) when a refund fails outright.
 *  - a PARTIAL refund also returns the order to its fulfilment state (RETURNED -> DELIVERED while units remain), so it can
 *    still ship or have other items returned; PARTIALLY_REFUNDED is only the closing state when nothing is left to do.
 */
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  CREATED: ['INVENTORY_RESERVED', 'CANCELLED'],
  INVENTORY_RESERVED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'REFUND_PENDING'],
  PROCESSING: ['SHIPPED', 'REFUND_PENDING'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['RETURN_REQUESTED', 'REFUND_PENDING'],
  RETURN_REQUESTED: ['RETURN_APPROVED', 'DELIVERED'],
  RETURN_APPROVED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUND_PENDING'],
  REFUND_PENDING: [
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'PAID',
    'PROCESSING',
    'DELIVERED',
    'RETURNED',
  ],
  PARTIALLY_REFUNDED: ['REFUND_PENDING'],
  REFUNDED: [],
  CANCELLED: [],
};

/** States in which the customer has not paid yet and the order can simply be abandoned. */
export const UNPAID_CANCELLABLE: readonly OrderStatus[] = [
  'CREATED',
  'INVENTORY_RESERVED',
  'PAYMENT_PENDING',
  'PAYMENT_FAILED',
];
/** Paid, not yet shipped: the customer may still cancel (full refund). */
export const PAID_CANCELLABLE: readonly OrderStatus[] = ['PAID', 'PROCESSING'];
/** States from which refund activity may start. */
export const REFUNDABLE: readonly OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'DELIVERED',
  'RETURNED',
  'PARTIALLY_REFUNDED',
  'REFUND_PENDING',
];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly entity: 'order' | 'payment',
  ) {
    super(`Illegal ${entity} transition ${from} -> ${to}`);
  }
}

export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!canTransitionOrder(from, to))
    throw new InvalidTransitionError(from, to, 'order');
}
