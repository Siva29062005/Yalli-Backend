import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export interface RateLimitRule {
  /** Namespace for the counter, e.g. "login-ip". */
  name: string;
  limit: number;
  windowSeconds: number;
  /** What the limit is keyed on. A function may return undefined to skip the rule for this request. */
  key: 'ip' | 'principal' | ((req: Request) => string | undefined);
  /** If the counter store is down: true = fail closed (503), false = fail open. Default true. */
  sensitive?: boolean;
}

export const RATE_LIMIT_KEY = 'ratelimit:rules';

/** Per-route limits, applied in ADDITION to the global per-IP limit. */
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);
