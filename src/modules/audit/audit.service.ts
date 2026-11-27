import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
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

function toRow(event: AuditEvent) {
  return {
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
  } satisfies Prisma.AuditLogUncheckedCreateInput;
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
      await this.prisma.auditLog.create({ data: toRow(event) });
    } catch (err) {
      this.logger.error({ err, action: event.action }, 'Audit write failed');
    }
  }

  /**
   * Same row, written on the caller's transaction: use this INSIDE `$transaction` (the shared client would take a
   * second connection and can starve the pool). The row commits or rolls back with the business change. Errors are NOT
   * swallowed: a failed insert aborts the PostgreSQL transaction anyway, so pretending it succeeded would be a lie.
   */
  async recordInTx(
    tx: Prisma.TransactionClient,
    event: AuditEvent,
  ): Promise<void> {
    await tx.auditLog.create({ data: toRow(event) });
  }
}
