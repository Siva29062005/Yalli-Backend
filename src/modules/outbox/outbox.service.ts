import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId?: string | null | undefined;
  eventVersion?: number;
}

/**
 * Transactional outbox: the event row is written in the SAME transaction as the business change, so an event exists
 * if and only if the change committed. A separate relay publishes it. Never publish to the broker inside a transaction.
 */
@Injectable()
export class OutboxService {
  add(tx: Prisma.TransactionClient, e: OutboxEventInput) {
    return tx.outboxEvent.create({
      data: {
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        eventType: e.eventType,
        eventVersion: e.eventVersion ?? 1,
        payload: e.payload as Prisma.InputJsonValue,
        correlationId: e.correlationId ?? null,
      },
    });
  }
}
