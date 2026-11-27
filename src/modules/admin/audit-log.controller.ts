import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  RequirePermissions,
  RequireStepUp,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { paginated, paginationSchema } from '../../common/http/pagination.js';
import { Paginated } from '../../common/interceptors/response-envelope.interceptor.js';
import { maskEmail } from '../../common/utils/mask.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { Permission } from '../access/permissions.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditReader } from '../audit/audit-reader.service.js';

const ACTIONS = Object.values(AuditAction) as [string, ...string[]];
const CATEGORIES = [...new Set(ACTIONS.map((a) => a.split('.')[0]!))] as [
  string,
  ...string[],
];
const MAX_DAYS = 92;
const DAY = 86_400_000;

const auditQuerySchema = paginationSchema
  .extend({
    from: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
    action: z.enum(ACTIONS).optional(),
    category: z.enum(CATEGORIES).optional(),
    actorId: z.uuid().optional(),
    resourceType: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
    resourceId: z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,128}$/)
      .optional(),
    outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.to > v.from, {
    message: 'to must be after from',
    path: ['to'],
  });

/**
 * Security: the audit-log viewer (audit.read, recent MFA). Rows come from the read-only reporting role; actor labels
 * are added here (a staff member's email, a customer's masked email). Periods are bounded (default last 7 days, at
 * most 92), so the count stays cheap.
 */
@ApiTags('admin-audit')
@Controller('admin/audit-logs')
@RequireStepUp(1800)
@RequirePermissions(Permission.AuditRead)
@RateLimit({
  name: 'admin-audit',
  limit: 60,
  windowSeconds: 60,
  key: 'principal',
})
export class AuditLogController {
  constructor(
    private readonly reader: AuditReader,
    private readonly prisma: PrismaService,
  ) {}

  /** The audit actions and categories the viewer can filter by. */
  @Get('actions')
  actions() {
    return { actions: [...ACTIONS].sort(), categories: [...CATEGORIES].sort() };
  }

  @Get()
  async list(
    @Query({ schema: auditQuerySchema }) q: z.infer<typeof auditQuerySchema>,
  ) {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 7 * DAY);
    // A wider window is cut to the most recent MAX_DAYS (the answer says which period it covers).
    const start = new Date(
      Math.max(from.getTime(), to.getTime() - MAX_DAYS * DAY),
    );
    const { items, total } = await this.reader.search({
      ...q,
      from: start,
      to,
    });
    const ids = [
      ...new Set(items.map((r) => r.actorId).filter((x): x is string => !!x)),
    ];
    const [users, staff] = ids.length
      ? await Promise.all([
          this.prisma.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, email: true },
          }),
          this.prisma.userRole.findMany({
            where: { userId: { in: ids }, role: { name: { not: 'CUSTOMER' } } },
            select: { userId: true },
          }),
        ])
      : [[], []];
    const isStaff = new Set(staff.map((s) => s.userId));
    const label = new Map(
      users.map((u) => [
        u.id,
        isStaff.has(u.id) ? u.email : maskEmail(u.email),
      ]),
    );
    const page = paginated(
      items.map((r) => ({
        ...r,
        actorLabel: r.actorId ? (label.get(r.actorId) ?? null) : null,
      })),
      total,
      q,
    );
    // the period actually searched (a wider request is cut to MAX_DAYS)
    return new Paginated(page.items, { ...page.meta, from: start, to });
  }
}
