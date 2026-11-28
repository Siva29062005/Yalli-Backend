import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { MessageBus, type EventEnvelope } from './message-bus.js';

const LEASE_SECONDS = 60;
const BATCH = 50;
const MAX_BACKOFF_SECONDS = 3_600;
const backoffSeconds = (attempts: number) =>
  Math.min(5 * 2 ** Math.min(attempts, 10), MAX_BACKOFF_SECONDS);

interface Row {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  created_at: Date;
  attempts: number;
}

/**
 * Publishes committed outbox rows. Safe with many instances: a batch is CLAIMED with a short lease
 * (FOR UPDATE SKIP LOCKED), published outside any transaction, then marked published. A crash between publish and mark
 * re-publishes after the lease expires (at-least-once; consumers de-duplicate on the event id).
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly bus: MessageBus,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('BACKGROUND_JOBS_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.tick(), 2_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One relay pass. Returns how many events were published. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await this.prisma.$queryRaw<Row[]>`
        UPDATE outbox_events SET next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE id IN (
          SELECT o.id FROM outbox_events o
          WHERE o.published_at IS NULL AND o.next_attempt_at <= now()
            -- only the oldest unpublished event of its aggregate: a failed (backing-off) event holds back the later
            -- events of the SAME aggregate until it is published, and nothing else
            AND NOT EXISTS (
              SELECT 1 FROM outbox_events e
              WHERE e.aggregate_type = o.aggregate_type AND e.aggregate_id = o.aggregate_id
                AND e.published_at IS NULL AND (e.created_at, e.id) < (o.created_at, o.id))
          ORDER BY o.created_at LIMIT ${BATCH}
          FOR UPDATE OF o SKIP LOCKED)
        RETURNING id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id, created_at, attempts`;
      let published = 0;
      // Each claimed event is the head of a different aggregate: a failure backs off that aggregate only (the claim
      // query keeps its later events back), so the loop carries on with the others.
      for (const row of claimed.sort(
        (a, b) => a.created_at.getTime() - b.created_at.getTime(),
      )) {
        const envelope: EventEnvelope = {
          id: row.id,
          type: row.event_type,
          version: row.event_version,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          occurredAt: row.created_at.toISOString(),
          correlationId: row.correlation_id,
          payload: row.payload,
        };
        try {
          await this.bus.publish(envelope);
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { publishedAt: new Date(), lastError: null },
          });
          published++;
        } catch (err) {
          const attempts = row.attempts + 1;
          await this.prisma.$executeRaw`
            UPDATE outbox_events SET attempts = ${attempts}, last_error = ${String((err as Error).message).slice(0, 300)},
              next_attempt_at = now() + make_interval(secs => ${backoffSeconds(attempts)})
            WHERE id = ${row.id}::uuid`;
          this.logger.warn(
            { eventId: row.id, type: row.event_type, attempts },
            'Outbox publish failed; will retry with backoff',
          );
        }
      }
      return published;
    } finally {
      this.running = false;
    }
  }

  /** Alerting hook: events unpublished for longer than `olderThanSeconds`. */
  async backlog(olderThanSeconds = 300): Promise<number> {
    return this.prisma.outboxEvent.count({
      where: {
        publishedAt: null,
        createdAt: { lt: new Date(Date.now() - olderThanSeconds * 1000) },
      },
    });
  }
}
