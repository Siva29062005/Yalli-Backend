import { Injectable } from '@nestjs/common';
import { EphemeralStore } from './ephemeral-store.js';

interface Entry {
  value: string;
  expiresAt: number;
}

/** Test double with the same semantics as the Redis implementation. Also used by unit tests. */
@Injectable()
export class InMemoryEphemeralStore extends EphemeralStore {
  private readonly data = new Map<string, Entry>();
  /** Test hook: shift the clock. */
  now: () => number = () => Date.now();

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (e && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  del(...keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
    return Promise.resolve();
  }

  incr(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const existing = this.live(key);
    if (!existing) {
      this.data.set(key, {
        value: '1',
        expiresAt: this.now() + windowSeconds * 1000,
      });
      return Promise.resolve({ count: 1, ttlSeconds: windowSeconds });
    }
    const count = Number(existing.value) + 1;
    existing.value = String(count);
    return Promise.resolve({
      count,
      ttlSeconds: Math.max(
        1,
        Math.ceil((existing.expiresAt - this.now()) / 1000),
      ),
    });
  }

  clear(): void {
    this.data.clear();
  }
}
