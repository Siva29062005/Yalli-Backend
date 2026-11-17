import { Injectable } from '@nestjs/common';
import { EphemeralStore } from './ephemeral-store.js';
import { RedisService } from './redis.service.js';

const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if c == 1 or ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}
`;

@Injectable()
export class RedisEphemeralStore extends EphemeralStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  get(key: string): Promise<string | null> {
    return this.redis.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.client.set(
      key,
      value,
      'EX',
      Math.max(1, Math.ceil(ttlSeconds)),
    );
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.client.del(...keys);
  }

  async incr(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const [count, ttl] = (await this.redis.client.eval(
      INCR_SCRIPT,
      1,
      key,
      String(windowSeconds),
    )) as [number, number];
    return { count, ttlSeconds: Math.max(1, ttl) };
  }
}
