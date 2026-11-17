import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import type { Env } from '../../config/env.js';
import {
  MessageBus,
  type EventEnvelope,
  type EventHandler,
} from './message-bus.js';

const EXCHANGE = 'yalli.events';
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 30_000;

/**
 * RabbitMQ transport.
 *  - Topic exchange `yalli.events`, routing key = event type, persistent messages, publisher confirms.
 *  - One durable QUORUM queue per consumer; failures go to a TTL "retry" queue that dead-letters back, up to
 *    MAX_RETRIES times, then to a parking-lot `<consumer>.dlq` for operators. No message is dropped silently.
 *  - The connection is established lazily and re-established after failure; publish() rejects while disconnected, which
 *    the outbox relay turns into backoff + retry (nothing is lost: the event is still in PostgreSQL).
 */
@Injectable()
export class RabbitMqBus extends MessageBus implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqBus.name);
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  private connecting: Promise<ConfirmChannel> | undefined;
  /** `boundTo` records WHICH channel a consumer is attached to, so it binds exactly once per connection. */
  private readonly registrations: {
    consumer: string;
    types: readonly string[];
    handler: EventHandler;
    boundTo?: ConfirmChannel;
  }[] = [];

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      this.connecting ??= this.open().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    const channel = this.channel;
    if (!channel) throw new Error('RabbitMQ channel unavailable');
    await this.bindPending(channel); // retries consumers that failed to bind earlier
    return channel;
  }

  private async bindPending(channel: ConfirmChannel): Promise<void> {
    for (const r of this.registrations) {
      if (r.boundTo === channel) continue;
      try {
        await this.bind(channel, r.consumer, r.types, r.handler);
        r.boundTo = channel;
      } catch (err) {
        this.logger.warn(
          { consumer: r.consumer, err: (err as Error).message },
          'Could not bind consumer yet; will retry',
        );
      }
    }
  }

  private async open(): Promise<ConfirmChannel> {
    const conn = await connect(
      this.config.get('RABBITMQ_URL', { infer: true }),
      { timeout: 5_000 },
    );
    const drop = (why: string) => {
      this.logger.warn(
        `RabbitMQ connection ${why}; will reconnect on next use`,
      );
      this.channel = undefined;
      this.connection = undefined;
    };
    conn.on('error', () => drop('error'));
    conn.on('close', () => drop('closed'));
    const channel = await conn.createConfirmChannel();
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(`${EXCHANGE}.retry`, 'direct', {
      durable: true,
    });
    await channel.assertExchange(`${EXCHANGE}.dlx`, 'direct', {
      durable: true,
    });
    this.connection = conn;
    this.channel = channel;
    return channel; // consumers are attached by ensureChannel -> bindPending
  }

  async publish(event: EventEnvelope): Promise<void> {
    const channel = await this.ensureChannel();
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE,
        event.type,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          messageId: event.id,
          type: event.type,
          contentType: 'application/json',
          timestamp: Date.now(),
          headers: { 'x-correlation-id': event.correlationId ?? '' },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  async subscribe(
    consumer: string,
    eventTypes: readonly string[],
    handler: EventHandler,
  ): Promise<void> {
    this.registrations.push({ consumer, types: eventTypes, handler });
    try {
      await this.ensureChannel(); // connects (if needed) and binds this registration exactly once
    } catch (err) {
      // Broker not reachable yet: the registration is replayed as soon as a connection opens.
      this.logger.warn(
        { consumer, err: (err as Error).message },
        'RabbitMQ unavailable; consumer will bind when it is',
      );
    }
  }

  private async bind(
    channel: Channel,
    consumer: string,
    types: readonly string[],
    handler: EventHandler,
  ): Promise<void> {
    const main = `yalli.${consumer}`;
    const retry = `${main}.retry`;
    const dlq = `${main}.dlq`;
    await channel.assertQueue(dlq, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.bindQueue(dlq, `${EXCHANGE}.dlx`, consumer);
    await channel.assertQueue(retry, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': RETRY_DELAY_MS,
        'x-dead-letter-exchange': EXCHANGE,
        'x-dead-letter-routing-key': `retry.${consumer}`,
      },
    });
    await channel.bindQueue(retry, `${EXCHANGE}.retry`, consumer);
    await channel.assertQueue(main, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    for (const t of types) await channel.bindQueue(main, EXCHANGE, t);
    await channel.bindQueue(main, EXCHANGE, `retry.${consumer}`); // messages returning from the retry queue
    await channel.prefetch(10);
    await channel.consume(
      main,
      (msg) => void this.handle(channel, consumer, handler, msg),
    );
  }

  private async handle(
    channel: Channel,
    consumer: string,
    handler: EventHandler,
    msg: ConsumeMessage | null,
  ): Promise<void> {
    if (!msg) return;
    const attempts = Number(msg.properties.headers?.['x-attempts'] ?? 0);
    try {
      await handler(JSON.parse(msg.content.toString('utf8')) as EventEnvelope);
      channel.ack(msg);
    } catch (err) {
      this.logger.error(
        {
          consumer,
          messageId: msg.properties.messageId,
          attempts,
          err: (err as Error).message,
        },
        'Event handler failed',
      );
      const opts = {
        persistent: true,
        messageId: msg.properties.messageId,
        type: msg.properties.type,
        headers: {
          ...msg.properties.headers,
          'x-attempts': attempts + 1,
          'x-last-error': String((err as Error).message).slice(0, 200),
        },
      };
      // Republish first, ack after: a crash in between yields a duplicate (tolerated), never a loss.
      if (attempts + 1 >= MAX_RETRIES)
        channel.publish(`${EXCHANGE}.dlx`, consumer, msg.content, opts);
      else channel.publish(`${EXCHANGE}.retry`, consumer, msg.content, opts);
      channel.ack(msg);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
