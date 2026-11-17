import { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from './message-bus.js';

/** A recording fake of the amqplib channel: lets us assert the broker topology and the retry/DLQ behaviour. */
class FakeChannel {
  exchanges: { name: string; type: string }[] = [];
  queues: { name: string; args: Record<string, unknown> }[] = [];
  bindings: { queue: string; exchange: string; key: string }[] = [];
  published: {
    exchange: string;
    key: string;
    body: Buffer;
    opts: Record<string, unknown>;
  }[] = [];
  acked: ConsumeMessage[] = [];
  consumers = new Map<string, (m: ConsumeMessage | null) => void>();
  failConfirm: Error | null = null;
  assertExchange(name: string, type: string) {
    this.exchanges.push({ name, type });
    return Promise.resolve();
  }
  assertQueue(name: string, opts: { arguments?: Record<string, unknown> }) {
    this.queues.push({ name, args: opts.arguments ?? {} });
    return Promise.resolve();
  }
  bindQueue(queue: string, exchange: string, key: string) {
    this.bindings.push({ queue, exchange, key });
    return Promise.resolve();
  }
  prefetch() {
    return Promise.resolve();
  }
  consume(queue: string, cb: (m: ConsumeMessage | null) => void) {
    this.consumers.set(queue, cb);
    return Promise.resolve({ consumerTag: 't' });
  }
  publish(
    exchange: string,
    key: string,
    body: Buffer,
    opts: Record<string, unknown>,
    cb?: (err: Error | null) => void,
  ) {
    this.published.push({ exchange, key, body, opts });
    cb?.(this.failConfirm);
    return true;
  }
  ack(m: ConsumeMessage) {
    this.acked.push(m);
  }
  close() {
    return Promise.resolve();
  }
}

const channel = new FakeChannel();
let connectFails = false;
vi.mock('amqplib', () => ({
  connect: vi.fn(() =>
    connectFails
      ? Promise.reject(new Error('ECONNREFUSED'))
      : Promise.resolve({
          on: vi.fn(),
          createConfirmChannel: () => Promise.resolve(channel),
          close: () => Promise.resolve(),
        }),
  ),
}));

const { RabbitMqBus } = await import('./rabbitmq-bus.js');
const config = new ConfigService({ RABBITMQ_URL: 'amqp://u:p@localhost:5672' });
const event: EventEnvelope = {
  id: 'evt-1',
  type: 'order.paid',
  version: 1,
  aggregateType: 'order',
  aggregateId: 'o1',
  occurredAt: '2026-11-16T00:00:00.000Z',
  correlationId: 'corr-1',
  payload: { orderId: 'o1' },
};
const delivery = (attempts = 0): ConsumeMessage =>
  ({
    content: Buffer.from(JSON.stringify(event)),
    fields: {},
    properties: {
      messageId: 'evt-1',
      type: 'order.paid',
      headers: { 'x-attempts': attempts },
    },
  }) as unknown as ConsumeMessage;

describe('RabbitMqBus', () => {
  beforeEach(() => {
    Object.assign(channel, {
      exchanges: [],
      queues: [],
      bindings: [],
      published: [],
      acked: [],
      failConfirm: null,
    });
    channel.consumers.clear();
    connectFails = false;
  });

  it('publishes persistent, confirmed messages to the topic exchange keyed by event type', async () => {
    const bus = new RabbitMqBus(config as never);
    await bus.publish(event);
    expect(channel.exchanges).toEqual(
      expect.arrayContaining([{ name: 'yalli.events', type: 'topic' }]),
    );
    const p = channel.published[0]!;
    expect(p).toMatchObject({
      exchange: 'yalli.events',
      key: 'order.paid',
      opts: { persistent: true, messageId: 'evt-1', type: 'order.paid' },
    });
    expect(JSON.parse(p.body.toString())).toEqual(event);
  });

  it('a broker NACK / confirm failure rejects publish (so the outbox keeps the event and retries)', async () => {
    const bus = new RabbitMqBus(config as never);
    channel.failConfirm = new Error('nack');
    await expect(bus.publish(event)).rejects.toThrow('nack');
  });

  it('an unreachable broker rejects publish instead of dropping the event', async () => {
    connectFails = true;
    await expect(
      new RabbitMqBus(config as never).publish(event),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('declares per-consumer DURABLE QUORUM queues with retry (TTL, dead-letters back) and a parking-lot DLQ', async () => {
    const bus = new RabbitMqBus(config as never);
    await bus.subscribe(
      'notifications',
      ['order.paid', 'refund.processed'],
      () => Promise.resolve(),
    );
    const q = Object.fromEntries(channel.queues.map((x) => [x.name, x.args]));
    expect(Object.keys(q).sort()).toEqual([
      'yalli.notifications',
      'yalli.notifications.dlq',
      'yalli.notifications.retry',
    ]);
    for (const args of Object.values(q))
      expect(args['x-queue-type']).toBe('quorum');
    expect(q['yalli.notifications.retry']).toMatchObject({
      'x-message-ttl': 30_000,
      'x-dead-letter-exchange': 'yalli.events',
      'x-dead-letter-routing-key': 'retry.notifications',
    });
    const main = channel.bindings
      .filter((b) => b.queue === 'yalli.notifications')
      .map((b) => b.key)
      .sort();
    expect(main).toEqual([
      'order.paid',
      'refund.processed',
      'retry.notifications',
    ]);
  });

  it('acks a message only AFTER the handler succeeded', async () => {
    const bus = new RabbitMqBus(config as never);
    const seen: string[] = [];
    await bus.subscribe(
      'notifications',
      ['order.paid'],
      (e) => (seen.push(e.id), Promise.resolve()),
    );
    const m = delivery();
    channel.consumers.get('yalli.notifications')!(m);
    await vi.waitFor(() => expect(channel.acked).toContain(m));
    expect(seen).toEqual(['evt-1']);
    expect(channel.published).toHaveLength(0);
  });

  it('a failing handler sends the message to the RETRY queue with an attempt counter (never dropped, never hot-looped)', async () => {
    const bus = new RabbitMqBus(config as never);
    await bus.subscribe('notifications', ['order.paid'], () =>
      Promise.reject(new Error('SES down')),
    );
    const m = delivery(0);
    channel.consumers.get('yalli.notifications')!(m);
    await vi.waitFor(() => expect(channel.acked).toContain(m));
    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]).toMatchObject({
      exchange: 'yalli.events.retry',
      key: 'notifications',
      opts: {
        persistent: true,
        headers: { 'x-attempts': 1, 'x-last-error': 'SES down' },
      },
    });
  });

  it('after the retry budget is exhausted the message is PARKED in the dead-letter queue for operators', async () => {
    const bus = new RabbitMqBus(config as never);
    await bus.subscribe('notifications', ['order.paid'], () =>
      Promise.reject(new Error('still failing')),
    );
    const m = delivery(4); // the 5th failure
    channel.consumers.get('yalli.notifications')!(m);
    await vi.waitFor(() => expect(channel.acked).toContain(m));
    expect(channel.published[0]).toMatchObject({
      exchange: 'yalli.events.dlx',
      key: 'notifications',
    });
    expect(Buffer.compare(channel.published[0]!.body, m.content)).toBe(0); // the original payload is preserved
  });

  it('subscribing while the broker is down does not crash; the consumer binds when a connection opens', async () => {
    connectFails = true;
    const bus = new RabbitMqBus(config as never);
    await bus.subscribe('notifications', ['order.paid'], () =>
      Promise.resolve(),
    );
    expect(channel.consumers.size).toBe(0);
    connectFails = false;
    await bus.publish(event); // first successful connection replays the registrations
    expect(channel.consumers.has('yalli.notifications')).toBe(true);
  });
});
