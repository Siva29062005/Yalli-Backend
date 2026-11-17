/**
 * Short-lived key/value state: rate-limit counters, revocation flags, MFA challenges, auth caches.
 * Never authoritative for orders, inventory or payments. Redis in runtime, in-memory in tests.
 */
export abstract class EphemeralStore {
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlSeconds: number): Promise<void>;
  abstract del(...keys: string[]): Promise<void>;
  /** Fixed-window counter: increments atomically; the TTL is set when the window opens. */
  abstract incr(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }>;
}
