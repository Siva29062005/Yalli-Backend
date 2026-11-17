import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  assertOrderTransition,
  InvalidTransitionError,
} from './order-state-machine.js';

type Tx = Prisma.TransactionClient;

export interface Actor {
  type: 'USER' | 'ADMIN' | 'SYSTEM' | 'PROVIDER';
  id?: string | null;
}

export interface TransitionExtras {
  paidAt?: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  inventoryReleasedAt?: Date;
  trackingCarrier?: string | null;
  trackingNumber?: string | null;
  statusBeforeRefund?: OrderStatus | null;
}

/**
 * The ONE place an order changes state. It locks the row, validates the move against the state machine, writes the
 * immutable history entry and (optionally) an outbox event, all inside the caller's transaction.
 */
@Injectable()
export class OrderLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** `SELECT … FOR UPDATE`: concurrent webhook / callback / admin actions on one order are serialised. */
  async lock(tx: Tx, orderId: string) {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async transition(
    tx: Tx,
    orderId: string,
    to: OrderStatus,
    actor: Actor,
    opts: {
      reason?: string;
      extras?: TransitionExtras;
      event?: { type: string; payload?: Record<string, unknown> };
    } = {},
  ) {
    const order = await this.lock(tx, orderId);
    if (order.status === to) return order; // idempotent: already there
    try {
      assertOrderTransition(order.status, to);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException({
          message: `This order cannot move from ${order.status} to ${to}`,
          code: 'INVALID_ORDER_TRANSITION',
        });
      }
      throw err;
    }
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: to, ...opts.extras },
    });
    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: to,
        actorType: actor.type,
        actorId: actor.id ?? null,
        reason: opts.reason ?? null,
      },
    });
    if (opts.event) {
      await this.outbox.add(tx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: opts.event.type,
        payload: {
          orderId,
          orderNumber: order.orderNumber,
          userId: order.userId,
          from: order.status,
          to,
          ...opts.event.payload,
        },
      });
    }
    return updated;
  }

  /**
   * Abandons an UNPAID order: status, stock reservation, coupon and open payment attempt are all released together.
   * (A paid order is never "abandoned": it is cancelled through a refund.)
   */
  async cancelUnpaid(
    tx: Tx,
    orderId: string,
    actor: Actor,
    reason: string,
    inventory: {
      releaseInTx(
        tx: Tx,
        ref: { referenceType: string; referenceId: string },
        reason: string,
      ): Promise<number>;
    },
    coupons: {
      releaseInTx(
        tx: Tx,
        referenceType: string,
        referenceId: string,
      ): Promise<void>;
    },
  ) {
    const now = new Date();
    const order = await this.transition(tx, orderId, 'CANCELLED', actor, {
      reason,
      extras: {
        cancelledAt: now,
        cancelReason: reason.slice(0, 200),
        inventoryReleasedAt: now,
      },
      event: { type: 'order.cancelled', payload: { reason, paid: false } },
    });
    await inventory.releaseInTx(
      tx,
      { referenceType: 'ORDER', referenceId: orderId },
      reason,
    );
    await coupons.releaseInTx(tx, 'ORDER', orderId);
    // An unpaid, still-open payment attempt is closed locally. If the customer pays at the provider anyway, the late
    // capture is detected and refunded automatically (see PaymentService).
    await tx.payment.updateMany({
      where: {
        orderId,
        status: { in: ['CREATED', 'PENDING', 'AUTHORIZED', 'FAILED'] },
      },
      data: { status: 'CANCELLED' },
    });
    return order;
  }

  /** Orders still in the checkout window whose payment window has passed. */
  expiredUnpaid(now = new Date(), limit = 100) {
    return this.prisma.order.findMany({
      where: {
        status: {
          in: ['INVENTORY_RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'],
        },
        paymentExpiresAt: { lt: now },
      },
      orderBy: { paymentExpiresAt: 'asc' },
      take: limit,
      select: { id: true },
    });
  }
}
