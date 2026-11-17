/** Envelope for every domain event. `id` is the outbox row id: stable across retries, so consumers can de-duplicate. */
export interface EventEnvelope {
  id: string;
  type: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: EventEnvelope) => Promise<void>;

/**
 * Event transport port. Delivery is AT-LEAST-ONCE: handlers must be idempotent (see ProcessedMessage / runOnce).
 * Events are published only AFTER the business transaction committed (they originate from the outbox table).
 */
export abstract class MessageBus {
  abstract publish(event: EventEnvelope): Promise<void>;
  /** Registers a named consumer for the given event types (names are stable: they identify queues and dedupe keys). */
  abstract subscribe(
    consumer: string,
    eventTypes: readonly string[],
    handler: EventHandler,
  ): Promise<void>;
}
