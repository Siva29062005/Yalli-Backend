import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ReportingDb } from '../../infrastructure/database/reporting-db.js';

export interface AuditQuery {
  page: number;
  pageSize: number;
  from: Date;
  to: Date;
  action?: string | undefined;
  /** "refund" matches refund.requested, refund.approved, … */
  category?: string | undefined;
  actorId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED' | undefined;
}

export interface AuditRow {
  id: string;
  occurredAt: Date;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  ip: string | null;
  correlationId: string | null;
  metadata: unknown;
}

/**
 * Reads the audit log for the staff viewer through the READ-ONLY reporting role (column grants: no user agent; it can
 * never write). Parameterised SQL with a fixed ORDER BY; the caller bounds the period.
 */
@Injectable()
export class AuditReader {
  constructor(private readonly reporting: ReportingDb) {}

  async search(q: AuditQuery): Promise<{ items: AuditRow[]; total: number }> {
    const conds: Prisma.Sql[] = [
      Prisma.sql`occurred_at >= ${q.from}`,
      Prisma.sql`occurred_at < ${q.to}`,
    ];
    if (q.action) conds.push(Prisma.sql`action = ${q.action}`);
    if (q.category) conds.push(Prisma.sql`action LIKE ${`${q.category}.%`}`);
    if (q.actorId) conds.push(Prisma.sql`actor_id = ${q.actorId}::uuid`);
    if (q.resourceType)
      conds.push(Prisma.sql`resource_type = ${q.resourceType}`);
    if (q.resourceId) conds.push(Prisma.sql`resource_id = ${q.resourceId}`);
    if (q.outcome) conds.push(Prisma.sql`outcome = ${q.outcome}`);
    const where = Prisma.join(conds, ' AND ');
    const [rows, count] = await Promise.all([
      this.reporting.client.$queryRaw<AuditRow[]>`
        SELECT id, occurred_at AS "occurredAt", actor_id AS "actorId", actor_type AS "actorType", action,
               resource_type AS "resourceType", resource_id AS "resourceId", outcome, ip,
               correlation_id AS "correlationId", metadata
        FROM audit_logs WHERE ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      this.reporting.client.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_logs WHERE ${where}`,
    ]);
    return { items: rows, total: Number(count[0]?.n ?? 0) };
  }
}
