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
  /**
   * The route has its own budget INSTEAD of the global per-IP one. Only for traffic a browser sends by itself (CSP
   * reports): it must never use up the budget the same visitor needs for the shop.
   */
  replacesGlobal?: boolean;
}

export const RATE_LIMIT_KEY = 'ratelimit:rules';

/** Per-route limits, applied in ADDITION to the global per-IP limit (unless a rule says `replacesGlobal`). */
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);
