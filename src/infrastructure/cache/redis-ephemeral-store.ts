import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { EphemeralStore } from './ephemeral-store.js';
import { RedisService } from './redis.service.js';

const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if c == 1 or ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}
`;

/**
 * A Redis failure (down, unreachable, timed out) becomes a 503 with a fixed message: the request did not happen and can
 * be retried; a 500 would hide the cause from clients and monitoring. Sessions, rate limits and challenges FAIL CLOSED
 * (nothing is let through without Redis); callers that treat a cache as optional catch it themselves.
 */
export class EphemeralStoreUnavailable extends ServiceUnavailableException {
  constructor() {
    super({
      message:
        'The service is temporarily unavailable. Please try again shortly.',
      code: ErrorCode.ServiceUnavailable,
    });
  }
}

@Injectable()
export class RedisEphemeralStore extends EphemeralStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch {
      this.redis.markFailure();
      throw new EphemeralStoreUnavailable();
    }
  }

  get(key: string): Promise<string | null> {
    return this.run(() => this.redis.client.get(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.run(() =>
      this.redis.client.set(
        key,
        value,
        'EX',
        Math.max(1, Math.ceil(ttlSeconds)),
      ),
    );
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.run(() => this.redis.client.del(...keys));
  }

  async incr(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const [count, ttl] = (await this.run(() =>
      this.redis.client.eval(INCR_SCRIPT, 1, key, String(windowSeconds)),
    )) as [number, number];
    return { count, ttlSeconds: Math.max(1, ttl) };
  }
}
