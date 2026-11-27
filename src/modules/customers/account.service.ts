import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { STAFF_ROLE_RANK_THRESHOLD } from '../access/permissions.js';
import { AuthorizationService } from '../access/authorization.service.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { PasswordService } from '../identity/crypto/password.service.js';
import { MfaService } from '../identity/services/mfa.service.js';
import { SessionStateService } from '../identity/services/session-state.service.js';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionStateService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async updateProfile(
    principal: AuthPrincipal,
    dto: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      newsletterSubscribed?: boolean | undefined;
    },
    ctx: RequestContext,
  ) {
    const data = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    const customer = await this.prisma.customer.update({
      where: { userId: principal.userId },
      data,
      select: { firstName: true, lastName: true, newsletterSubscribed: true },
    });
    await this.audit.record({
      action: AuditAction.ProfileUpdated,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      metadata: { fields: Object.keys(data) },
    });
    return customer;
  }

  /** Sensitive operations re-prove identity: password, plus a TOTP code when MFA is on. */
  private async reauthenticate(
    principal: AuthPrincipal,
    password: string,
    code: string | undefined,
    ctx: RequestContext,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
    });
    const ok = await this.passwords.verify(user.passwordHash, password);
    const second =
      !user.mfaEnabled ||
      (code !== undefined && (await this.mfa.verifyTotp(user.id, code)));
    if (!ok || !second) {
      await this.audit.record({
        action: AuditAction.LoginFailure,
        outcome: 'FAILURE',
        actorId: user.id,
        ...ctx,
        metadata: { reason: 'reauth_failed' },
      });
      throw new UnauthorizedException({
        message: user.mfaEnabled
          ? 'Incorrect password or code'
          : 'Incorrect password',
        code: ErrorCode.Unauthorized,
      });
    }
    return user;
  }

  /** Right of access: everything we hold about the customer, in a machine-readable form. */
  async exportData(
    principal: AuthPrincipal,
    password: string,
    code: string | undefined,
    ctx: RequestContext,
  ) {
    const user = await this.reauthenticate(principal, password, code, ctx);
    const [
      customer,
      addresses,
      consents,
      sessions,
      events,
      cart,
      reviews,
      wishlist,
      contactMessages,
    ] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { userId: user.id },
        select: {
          firstName: true,
          lastName: true,
          newsletterSubscribed: true,
          createdAt: true,
        },
      }),
      this.prisma.address.findMany({
        where: { userId: user.id, deletedAt: null },
        select: {
          label: true,
          fullName: true,
          phoneE164: true,
          line1: true,
          line2: true,
          landmark: true,
          city: true,
          state: true,
          postalCode: true,
          countryCode: true,
          isDefault: true,
          createdAt: true,
        },
      }),
      this.prisma.consent.findMany({
        where: { userId: user.id },
        select: { type: true, version: true, acceptedAt: true },
      }),
      this.prisma.userSession.findMany({
        where: { userId: user.id },
        select: {
          deviceLabel: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          lastSeenAt: true,
          revokedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.auditLog.findMany({
        where: { actorId: user.id },
        select: { action: true, outcome: true, occurredAt: true, ip: true },
        orderBy: { occurredAt: 'desc' },
        take: 200,
      }),
      this.prisma.cart.findUnique({
        where: { userId: user.id },
        select: {
          items: {
            select: {
              quantity: true,
              variant: {
                select: { sku: true, product: { select: { name: true } } },
              },
            },
          },
        },
      }),
      this.prisma.productReview.findMany({
        where: { userId: user.id },
        select: {
          rating: true,
          title: true,
          body: true,
          status: true,
          createdAt: true,
          product: { select: { name: true } },
        },
      }),
      this.prisma.wishlistItem.findMany({
        where: { userId: user.id },
        select: { createdAt: true, product: { select: { name: true } } },
      }),
      this.prisma.contactMessage.findMany({
        where: { email: user.email },
        select: {
          topic: true,
          orderNumber: true,
          message: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    await this.audit.record({
      action: AuditAction.DataExported,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
    return {
      exportedAt: new Date().toISOString(),
      account: {
        email: user.email,
        phone: user.phoneE164,
        emailVerified: !!user.emailVerifiedAt,
        phoneVerified: !!user.phoneVerifiedAt,
        mfaEnabled: user.mfaEnabled,
        createdAt: user.createdAt,
      },
      profile: customer,
      addresses,
      consents,
      sessions,
      securityEvents: events,
      reviews: reviews.map((r) => ({
        product: r.product.name,
        rating: r.rating,
        title: r.title,
        body: r.body,
        status: r.status,
        createdAt: r.createdAt,
      })),
      wishlist: wishlist.map((w) => ({
        product: w.product.name,
        addedAt: w.createdAt,
      })),
      contactMessages,
      cart:
        cart?.items.map((i) => ({
          sku: i.variant.sku,
          product: i.variant.product.name,
          quantity: i.quantity,
        })) ?? [],
    };
  }

  /**
   * Right to erasure. Personal data is anonymised in place (rows referenced by future orders/audit keep their ids);
   * consent evidence and the audit trail are retained as required records. Staff accounts must be off-boarded by an admin.
   */
  async deleteAccount(
    principal: AuthPrincipal,
    password: string,
    code: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    if (principal.maxRank >= STAFF_ROLE_RANK_THRESHOLD) {
      throw new ForbiddenException({
        message: 'Staff accounts are closed by an administrator',
        code: ErrorCode.Forbidden,
      });
    }
    const user = await this.reauthenticate(principal, password, code, ctx);
    const placeholder = `deleted+${user.id}@deleted.invalid`;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          status: 'DELETED',
          email: placeholder,
          emailNormalized: placeholder,
          phoneE164: null,
          phoneVerifiedAt: null,
          // Unusable hash: not a valid Argon2 string, so no password can ever match.
          passwordHash: `!deleted!${randomBytes(16).toString('hex')}`,
          mfaEnabled: false,
        },
      }),
      this.prisma.customer.update({
        where: { userId: user.id },
        data: {
          firstName: 'Deleted',
          lastName: 'User',
          newsletterSubscribed: false,
        },
      }),
      this.prisma.address.deleteMany({ where: { userId: user.id } }),
      this.prisma.cart.deleteMany({ where: { userId: user.id } }),
      this.prisma.wishlistItem.deleteMany({ where: { userId: user.id } }),
      this.prisma.productReview.deleteMany({ where: { userId: user.id } }),
      this.prisma.mfaMethod.deleteMany({ where: { userId: user.id } }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.verificationToken.deleteMany({ where: { userId: user.id } }),
      // Contact-form messages are keyed by the address they were sent from (the form is public).
      this.prisma.contactMessage.deleteMany({ where: { email: user.email } }),
    ]);
    await this.sessions.revokeAllForUser(user.id, 'ACCOUNT_DELETED');
    await this.authz.invalidate(user.id);
    await this.audit.record({
      action: AuditAction.AccountDeleted,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
      resourceType: 'user',
      resourceId: user.id,
    });
  }
}
