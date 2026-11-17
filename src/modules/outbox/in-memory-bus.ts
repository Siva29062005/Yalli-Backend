import { Injectable } from '@nestjs/common';
import {
  MessageBus,
  type EventEnvelope,
  type EventHandler,
} from './message-bus.js';

/** Synchronous in-process bus: tests and brokerless local use. `duplicateDeliveries` simulates at-least-once redelivery. */
@Injectable()
export class InMemoryBus extends MessageBus {
  readonly published: EventEnvelope[] = [];
  duplicateDeliveries = false;
  failPublish: Error | null = null;
  private readonly consumers: {
    name: string;
    types: Set<string>;
    handler: EventHandler;
  }[] = [];

  publish(event: EventEnvelope): Promise<void> {
    if (this.failPublish) return Promise.reject(this.failPublish);
    this.published.push(event);
    return this.deliver(event);
  }

  subscribe(
    consumer: string,
    eventTypes: readonly string[],
    handler: EventHandler,
  ): Promise<void> {
    this.consumers.push({
      name: consumer,
      types: new Set(eventTypes),
      handler,
    });
    return Promise.resolve();
  }

  private async deliver(event: EventEnvelope): Promise<void> {
    for (const c of this.consumers) {
      if (!c.types.has(event.type)) continue;
      await c.handler(event);
      if (this.duplicateDeliveries) await c.handler(event);
    }
  }

  clear(): void {
    this.published.length = 0;
  }
}
