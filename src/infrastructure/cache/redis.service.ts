import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';

/**
 * Redis is a cache / rate-limit / ephemeral-state store ONLY.
 * Orders, inventory and payments are never authoritative here.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
      // a command waits at most this long (also while reconnecting): an outage answers 503 fast instead of hanging
      commandTimeout: 2_000,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    // Never log the URL or error payloads that might contain credentials.
    this.client.on('error', (e: Error) =>
      this.logger.warn(`Redis error: ${e.name}`),
    );
  }

  /** Counted for monitoring (logged at most once a minute so an outage does not flood the log). */
  private failures = 0;
  private lastReport = 0;
  markFailure(): void {
    this.failures += 1;
    const now = Date.now();
    if (now - this.lastReport > 60_000) {
      this.logger.error(
        { failures: this.failures },
        'Redis commands are failing: requests answer 503',
      );
      this.lastReport = now;
    }
  }

  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error('Unexpected Redis PING reply');
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
