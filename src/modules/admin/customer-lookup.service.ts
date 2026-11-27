import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { maskEmail, maskPhone } from '../../common/utils/mask.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuthorizationService } from '../access/authorization.service.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { normalizeEmail } from '../identity/services/identity-utils.js';
import { OrderService } from '../orders/order.service.js';

export type LookupBy =
  | { by: 'email'; value: string }
  | { by: 'phone'; value: string }
  | { by: 'order'; value: string };

/**
 * Support's customer lookup (customers.read). Privacy by design:
 *  - search only by an EXACT identifier the caller gives (email, phone, order number), never by partial text, so it
 *    cannot be used to browse the customer base;
 *  - contact details are masked; staff accounts are not shown (404), only customers;
 *  - every search and every profile view is audited with the staff member (never the searched value itself).
 */
@Injectable()
export class CustomerLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly orders: OrderService,
    private readonly audit: AuditService,
  ) {}

  async search(actor: AuthPrincipal, q: LookupBy, ctx: RequestContext) {
    const userId =
      q.by === 'order'
        ? await this.orders.ownerOfOrderNumber(q.value.trim().toUpperCase())
        : ((
            await this.prisma.user.findFirst({
              where:
                q.by === 'email'
                  ? { emailNormalized: normalizeEmail(q.value) }
                  : { phoneE164: q.value },
              select: { id: true },
            })
          )?.id ?? null);
    const found = userId ? await this.summary(userId) : null;
    await this.audit.record({
      action: AuditAction.CustomerSearched,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'customer',
      resourceId: found?.id,
      metadata: { by: q.by, found: found !== null },
    });
    return found ? [found] : [];
  }

  async get(actor: AuthPrincipal, userId: string, ctx: RequestContext) {
    const summary = await this.summary(userId);
    if (!summary) throw new NotFoundException('Customer not found');
    const history = await this.orders.adminCustomerHistory(userId);
    await this.audit.record({
      action: AuditAction.CustomerViewed,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'customer',
      resourceId: userId,
    });
    return { ...summary, ...history };
  }

  /** null for an unknown, deleted or STAFF account (support looks up customers only). */
  private async summary(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phoneE164: true,
        status: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        mfaEnabled: true,
        createdAt: true,
        lastLoginAt: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    });
    if (!u || u.status === 'DELETED' || (await this.authz.hasStaffRole(u.id)))
      return null;
    return {
      id: u.id,
      name: u.customer
        ? `${u.customer.firstName} ${u.customer.lastName}`.trim()
        : null,
      email: maskEmail(u.email),
      phone: u.phoneE164 ? maskPhone(u.phoneE164) : null,
      status: u.status,
      emailVerified: u.emailVerifiedAt !== null,
      phoneVerified: u.phoneVerifiedAt !== null,
      mfaEnabled: u.mfaEnabled,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }
}
