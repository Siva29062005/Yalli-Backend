import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  paginated,
  type PaginationInput,
} from '../../common/http/pagination.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuthorizationService } from '../access/authorization.service.js';
import { RoleName, STAFF_ROLE_RANK_THRESHOLD } from '../access/permissions.js';
import {
  canChangeRole,
  canChangeUserStatus,
  type PolicyActor,
  type PolicyDecision,
} from '../access/role-policy.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { SessionStateService } from '../identity/services/session-state.service.js';

/** Postgres serialization failure / write conflict, as surfaced by Prisma (P2034) or its driver adapter. */
const isSerializationConflict = (err: unknown): boolean => {
  const e = err as {
    code?: string;
    message?: string;
    cause?: { kind?: string; originalCode?: string };
  } | null;
  return (
    e?.code === 'P2034' ||
    e?.cause?.kind === 'TransactionWriteConflict' ||
    e?.cause?.originalCode === '40001' ||
    /TransactionWriteConflict|40001/.test(e?.message ?? '')
  );
};

const toActor = (p: AuthPrincipal): PolicyActor => ({
  userId: p.userId,
  maxRank: p.maxRank,
  roleNames: p.roles.map((r) => r.name),
  permissions: p.permissions,
});

@Injectable()
export class AdminAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sessions: SessionStateService,
    private readonly audit: AuditService,
  ) {}

  listRoles() {
    return this.prisma.role
      .findMany({
        orderBy: { rank: 'desc' },
        select: {
          name: true,
          description: true,
          rank: true,
          permissions: { select: { permission: { select: { name: true } } } },
        },
      })
      .then((roles) =>
        roles.map((r) => ({
          name: r.name,
          description: r.description,
          rank: r.rank,
          permissions: r.permissions.map((p) => p.permission.name).sort(),
        })),
      );
  }

  /** Staff view of accounts: identity, state and roles only (never credentials, tokens or phone numbers). */
  async listUsers(
    q: PaginationInput & {
      q?: string | undefined;
      role?: string | undefined;
      status?: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | undefined;
    },
  ) {
    const where: Prisma.UserWhereInput = {
      status: q.status ? q.status : { not: 'DELETED' },
      ...(q.role ? { roles: { some: { role: { name: q.role } } } } : {}),
      ...(q.q
        ? {
            OR: [
              { email: { contains: q.q, mode: 'insensitive' } },
              {
                customer: {
                  OR: [
                    { firstName: { contains: q.q, mode: 'insensitive' } },
                    { lastName: { contains: q.q, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          email: true,
          status: true,
          mfaEnabled: true,
          createdAt: true,
          lastLoginAt: true,
          customer: { select: { firstName: true, lastName: true } },
          roles: { select: { role: { select: { name: true, rank: true } } } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(
      rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.customer
          ? `${u.customer.firstName} ${u.customer.lastName}`.trim()
          : null,
        status: u.status,
        mfaEnabled: u.mfaEnabled,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        roles: u.roles
          .map((r) => r.role)
          .sort((a, b) => b.rank - a.rank)
          .map((r) => r.name),
      })),
      total,
      q,
    );
  }

  listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, description: true },
    });
  }

  async assignRole(
    actor: AuthPrincipal,
    targetUserId: string,
    roleName: string,
    ctx: RequestContext,
  ): Promise<void> {
    const { role, target } = await this.load(targetUserId, roleName);
    this.enforce(
      canChangeRole(
        toActor(actor),
        { userId: target.id, currentMaxRank: target.maxRank },
        { name: role.name, rank: role.rank, permissions: role.permissions },
      ),
      actor,
      AuditAction.RoleChangeDenied,
      ctx,
      { targetUserId, role: roleName, change: 'assign' },
    );
    // A staff role is only ever given to someone who ALREADY has a second factor. Otherwise a password that leaks before the
    // new colleague enrols would let an attacker enrol THEIR authenticator on a privileged account.
    if (role.rank >= STAFF_ROLE_RANK_THRESHOLD) {
      const mfa = await this.prisma.mfaMethod.count({
        where: { userId: target.id, status: 'ACTIVE' },
      });
      if (mfa === 0) {
        await this.audit.record({
          action: AuditAction.RoleChangeDenied,
          outcome: 'DENIED',
          actorId: actor.userId,
          ...ctx,
          metadata: { targetUserId, role: roleName, reason: 'mfa_required' },
        });
        throw new ConflictException({
          message:
            'This person must turn on two-step verification before they can be given a staff role',
          code: 'MFA_REQUIRED_FOR_STAFF',
        });
      }
    }
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: target.id, roleId: role.id } },
      update: {},
      create: { userId: target.id, roleId: role.id, grantedBy: actor.userId },
    });
    await this.authz.invalidate(target.id);
    // A staff role must not ride on a session opened as a customer: that session may be "remembered" for weeks and may
    // predate the second factor. Signing out everywhere forces a fresh staff sign-in (MFA, browser-session cookies,
    // STAFF_SESSION_MAX_HOURS).
    if (role.name !== 'CUSTOMER')
      await this.sessions.revokeAllForUser(target.id, 'ROLE_ASSIGNED');
    await this.audit.record({
      action: AuditAction.RoleAssigned,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'user',
      resourceId: target.id,
      metadata: { role: roleName },
    });
  }

  async revokeRole(
    actor: AuthPrincipal,
    targetUserId: string,
    roleName: string,
    ctx: RequestContext,
  ): Promise<void> {
    const { role, target } = await this.load(targetUserId, roleName);
    this.enforce(
      canChangeRole(
        toActor(actor),
        { userId: target.id, currentMaxRank: target.maxRank },
        { name: role.name, rank: role.rank, permissions: role.permissions },
      ),
      actor,
      AuditAction.RoleChangeDenied,
      ctx,
      { targetUserId, role: roleName, change: 'revoke' },
    );
    // Serializable: two concurrent revocations can never both succeed and leave the platform without a SUPER_ADMIN.
    // The loser of a serialization conflict gets a clean 409 (safe to retry) instead of a 500.
    try {
      await this.prisma.$transaction(
        async (tx) => {
          if (role.name === RoleName.SuperAdmin) {
            const holders = await tx.userRole.count({
              where: { roleId: role.id },
            });
            if (holders <= 1)
              throw new ConflictException({
                message: 'The last SUPER_ADMIN cannot be removed',
                code: ErrorCode.Conflict,
              });
          }
          await tx.userRole.deleteMany({
            where: { userId: target.id, roleId: role.id },
          });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (err) {
      if (isSerializationConflict(err)) {
        throw new ConflictException({
          message: 'Another change was in progress. Please retry.',
          code: ErrorCode.Conflict,
        });
      }
      throw err;
    }
    await this.authz.invalidate(target.id);
    // Losing privileges takes effect on the next request; also end the target's sessions so nothing stale lingers.
    await this.sessions.revokeAllForUser(target.id, 'ROLE_REVOKED');
    await this.audit.record({
      action: AuditAction.RoleRevoked,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'user',
      resourceId: target.id,
      metadata: { role: roleName },
    });
  }

  async setStatus(
    actor: AuthPrincipal,
    targetUserId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    const target = await this.loadTarget(targetUserId);
    this.enforce(
      canChangeUserStatus(toActor(actor), {
        userId: target.id,
        currentMaxRank: target.maxRank,
      }),
      actor,
      AuditAction.RoleChangeDenied,
      ctx,
      { targetUserId, change: 'status', status },
    );
    if (!['ACTIVE', 'SUSPENDED'].includes(target.status)) {
      throw new ConflictException({
        message: `A ${target.status.toLowerCase()} account cannot be changed this way`,
        code: ErrorCode.Conflict,
      });
    }
    await this.prisma.user.update({
      where: { id: target.id },
      data: { status },
    });
    await this.authz.invalidate(target.id);
    if (status === 'SUSPENDED')
      await this.sessions.revokeAllForUser(target.id, 'SUSPENDED');
    await this.audit.record({
      action: AuditAction.UserStatusChanged,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'user',
      resourceId: target.id,
      metadata: { from: target.status, to: status, reason },
    });
  }

  // ---------------------------------------------------------------------------------- helpers

  private enforce(
    decision: PolicyDecision,
    actor: AuthPrincipal,
    action: typeof AuditAction.RoleChangeDenied,
    ctx: RequestContext,
    metadata: Record<string, unknown>,
  ): void {
    if (decision.allowed) return;
    void this.audit.record({
      action,
      outcome: 'DENIED',
      actorId: actor.userId,
      ...ctx,
      metadata: { ...metadata, reason: decision.reason },
    });
    throw new ForbiddenException(
      'You do not have permission to perform this action',
    );
  }

  private async loadTarget(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
        roles: { select: { role: { select: { rank: true } } } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      status: user.status,
      maxRank: user.roles.reduce((m, r) => Math.max(m, r.role.rank), 0),
    };
  }

  private async load(userId: string, roleName: string) {
    const [target, role] = await Promise.all([
      this.loadTarget(userId),
      this.prisma.role.findUnique({
        where: { name: roleName },
        select: {
          id: true,
          name: true,
          rank: true,
          permissions: { select: { permission: { select: { name: true } } } },
        },
      }),
    ]);
    if (!role) throw new NotFoundException('Role not found');
    return {
      target,
      role: {
        id: role.id,
        name: role.name,
        rank: role.rank,
        permissions: role.permissions.map((p) => p.permission.name),
      },
    };
  }
}
