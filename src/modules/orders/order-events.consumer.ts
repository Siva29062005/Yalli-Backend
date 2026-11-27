import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  NotificationPort,
  type NotificationMessage,
} from '../identity/ports/ports.js';
import { MessageBus, type EventEnvelope } from '../outbox/message-bus.js';
import { MessageDeduplicator } from '../outbox/run-once.js';

const CONSUMER = 'notifications';
const EVENTS = [
  'order.paid',
  'order.payment_failed',
  'order.shipped',
  'order.delivered',
  'order.cancelled',
  'refund.processed',
  'return.decided',
] as const;

/**
 * Turns committed domain events into customer notifications. At-least-once delivery means every message can arrive
 * twice, so each one is recorded in `processed_messages` and handled once. Notification bodies never contain tokens,
 * passwords or payment details: only the order number and amounts.
 */
@Injectable()
export class OrderEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsConsumer.name);

  constructor(
    private readonly bus: MessageBus,
    private readonly dedupe: MessageDeduplicator,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationPort,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bus.subscribe(CONSUMER, EVENTS, (e) => this.handle(e));
  }

  async handle(event: EventEnvelope): Promise<void> {
    await this.dedupe.runOnce(CONSUMER, event.id, async (tx) => {
      const raw = event.payload['orderId'];
      const orderId = typeof raw === 'string' ? raw : '';
      // On the de-dupe transaction's connection, never a second one (pool rule).
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          orderNumber: true,
          totalMinor: true,
          contactEmail: true,
          shipName: true,
        },
      });
      if (!order) return;
      const base = {
        email: order.contactEmail,
        name: order.shipName,
        orderNumber: order.orderNumber,
      };
      const message = this.message(event, base, order.totalMinor);
      if (message) await this.notifications.send(message);
    });
  }

  private message(
    e: EventEnvelope,
    base: { email: string; name: string; orderNumber: string },
    totalMinor: number,
  ): NotificationMessage | null {
    switch (e.type) {
      case 'order.paid':
        return { type: 'ORDER_CONFIRMED', ...base, totalMinor };
      case 'order.payment_failed':
        return { type: 'PAYMENT_FAILED', ...base };
      case 'order.shipped':
        return { type: 'ORDER_SHIPPED', ...base };
      case 'order.delivered':
        return { type: 'ORDER_DELIVERED', ...base };
      case 'order.cancelled':
        return { type: 'ORDER_CANCELLED', ...base };
      case 'refund.processed':
        return {
          type: 'REFUND_PROCESSED',
          ...base,
          amountMinor: Number(e.payload['amountMinor'] ?? 0),
        };
      case 'return.decided':
        return {
          type: 'RETURN_UPDATE',
          ...base,
          status:
            typeof e.payload['decision'] === 'string'
              ? e.payload['decision']
              : 'UPDATED',
        };
      default:
        this.logger.warn({ type: e.type }, 'Unhandled event type');
        return null;
    }
  }
}
