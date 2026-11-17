import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { AuditActionName } from './audit-actions.js';

export interface AuditEvent {
  action: AuditActionName;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  actorId?: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'ANONYMOUS';
  resourceType?: string;
  resourceId?: string;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

/** Keys whose values must never reach the audit trail, at any depth. */
const SENSITIVE_KEY =
  /pass(word)?|token|secret|otp|code|authorization|cookie|card|cvv|pin\b|hash|key/i;
const MAX_STRING = 300;
const MAX_DEPTH = 4;

export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(
      0,
      50,
    )) {
      out[k] = SENSITIVE_KEY.test(k)
        ? '[REDACTED]'
        : sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}

export function requestContext(req: Request): RequestContext {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    correlationId: typeof req.id === 'string' ? req.id : null,
  };
}

/**
 * Writes to the append-only audit trail (INSERT only; the DB role cannot UPDATE/DELETE).
 * Trade-off: a failed audit write is logged loudly but does not fail the user's request, so an audit-store outage
 * cannot become an authentication outage. Alert on the "Audit write failed" log line.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: event.action,
          outcome: event.outcome,
          actorId: event.actorId ?? null,
          actorType: event.actorType ?? (event.actorId ? 'USER' : 'ANONYMOUS'),
          resourceType: event.resourceType ?? null,
          resourceId: event.resourceId ?? null,
          ip: event.ip ?? null,
          userAgent: event.userAgent ?? null,
          correlationId: event.correlationId ?? null,
          metadata: event.metadata
            ? (sanitizeMetadata(event.metadata) as object)
            : undefined,
        },
      });
    } catch (err) {
      this.logger.error({ err, action: event.action }, 'Audit write failed');
    }
  }
}
