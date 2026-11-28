import { ServiceUnavailableException } from '@nestjs/common';
import {
  EphemeralStoreUnavailable,
  RedisEphemeralStore,
} from './redis-ephemeral-store.js';
import type { RedisService } from './redis.service.js';

const down = () =>
  Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
const fake = (client: Record<string, unknown>) =>
  ({ client, markFailure: vi.fn() }) as unknown as RedisService & {
    markFailure: ReturnType<typeof vi.fn>;
  };

describe('Redis outage', () => {
  it('every operation answers 503 (never a 500, never the connection details)', async () => {
    const redis = fake({ get: down, set: down, del: down, eval: down });
    const store = new RedisEphemeralStore(redis);
    for (const call of [
      () => store.get('k'),
      () => store.set('k', 'v', 5),
      () => store.del('k'),
      () => store.incr('k', 60),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EphemeralStoreUnavailable);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(
        JSON.stringify((err as ServiceUnavailableException).getResponse()),
      ).not.toMatch(/10\.0\.0\.5|ECONNREFUSED/);
    }
    expect(redis.markFailure).toHaveBeenCalledTimes(4);
  });
  it('works normally when Redis answers', async () => {
    const redis = fake({
      get: () => Promise.resolve('v'),
      eval: () => Promise.resolve([3, 40]),
    });
    const store = new RedisEphemeralStore(redis);
    expect(await store.get('k')).toBe('v');
    expect(await store.incr('k', 60)).toEqual({ count: 3, ttlSeconds: 40 });
  });
  it('a reply error (a bug, e.g. WRONGTYPE) is not reported as an outage', async () => {
    const reply = Object.assign(
      new Error('WRONGTYPE Operation against a key'),
      { name: 'ReplyError' },
    );
    const redis = fake({ get: () => Promise.reject(reply) });
    await expect(new RedisEphemeralStore(redis).get('k')).rejects.toBe(reply);
    expect(redis.markFailure).not.toHaveBeenCalled();
  });
});
