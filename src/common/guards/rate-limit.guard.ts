import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  RATE_LIMIT_KEY,
  type RateLimitRule,
} from '../decorators/rate-limit.decorator.js';
import { EphemeralStore } from '../../infrastructure/cache/ephemeral-store.js';
import { AuditAction } from '../../modules/audit/audit-actions.js';
import {
  AuditService,
  requestContext,
} from '../../modules/audit/audit.service.js';
import { ErrorCode } from '../exceptions/error-codes.js';

/** Applies to every route; deliberately generous, it only blunts floods. */
const GLOBAL_RULE: RateLimitRule = {
  name: 'global',
  limit: 300,
  windowSeconds: 60,
  key: 'ip',
  sensitive: false,
};

abstract class BaseRateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');

  constructor(
    protected readonly reflector: Reflector,
    private readonly store: EphemeralStore,
    private readonly audit: AuditService,
  ) {}

  protected abstract rulesFor(declared: RateLimitRule[]): RateLimitRule[];

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const declared =
      this.reflector.getAllAndOverride<RateLimitRule[]>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    for (const rule of this.rulesFor(declared)) {
      const subject = this.subject(rule, req);
      if (subject === undefined) continue;
      const key = `rl:${rule.name}:${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`;
      let result: { count: number; ttlSeconds: number };
      try {
        result = await this.store.incr(key, rule.windowSeconds);
      } catch (err) {
        this.logger.error(
          { err, rule: rule.name },
          'Rate-limit store unavailable',
        );
        if (rule.sensitive === false) continue; // availability over strictness for the global flood guard
        throw new HttpException(
          {
            message: 'Service temporarily unavailable',
            code: ErrorCode.ServiceUnavailable,
          },
          503,
        );
      }
      if (result.count > rule.limit) {
        res.setHeader('Retry-After', String(result.ttlSeconds));
        if (result.count === rule.limit + 1) {
          // Audit only the first rejection per window so an attacker cannot turn the limiter into a DB write amplifier.
          void this.audit.record({
            action: AuditAction.RateLimited,
            outcome: 'DENIED',
            ...requestContext(req),
            metadata: { rule: rule.name },
          });
        }
        throw new HttpException(
          {
            message: 'Too many requests. Please try again later.',
            code: ErrorCode.TooManyRequests,
          },
          429,
        );
      }
    }
    return true;
  }

  private subject(rule: RateLimitRule, req: Request): string | undefined {
    if (rule.key === 'ip') return req.ip ?? 'unknown';
    if (rule.key === 'principal') return req.auth?.userId;
    return rule.key(req);
  }
}

/** Runs FIRST (before authentication): global + IP/body-keyed rules, so floods are cut off cheaply. */
@Injectable()
export class IpRateLimitGuard extends BaseRateLimitGuard {
  constructor(
    reflector: Reflector,
    store: EphemeralStore,
    audit: AuditService,
  ) {
    super(reflector, store, audit);
  }

  protected rulesFor(declared: RateLimitRule[]): RateLimitRule[] {
    return [GLOBAL_RULE, ...declared.filter((r) => r.key !== 'principal')];
  }
}

/** Runs AFTER authentication: rules keyed on the authenticated user. */
@Injectable()
export class PrincipalRateLimitGuard extends BaseRateLimitGuard {
  constructor(
    reflector: Reflector,
    store: EphemeralStore,
    audit: AuditService,
  ) {
    super(reflector, store, audit);
  }

  protected rulesFor(declared: RateLimitRule[]): RateLimitRule[] {
    return declared.filter((r) => r.key === 'principal');
  }
}
