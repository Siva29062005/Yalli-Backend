import { ConflictException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { Permission, ROLE_DEFINITIONS } from '../access/permissions.js';
import { AdminAccessService } from './admin-access.service.js';

const principal = (
  userId: string,
  role: keyof typeof ROLE_DEFINITIONS,
): AuthPrincipal => ({
  userId,
  sessionId: 's',
  amr: ['pwd', 'otp'],
  authTime: Math.floor(Date.now() / 1000),
  roles: [{ name: role, rank: ROLE_DEFINITIONS[role].rank }],
  permissions: new Set(ROLE_DEFINITIONS[role].permissions),
  maxRank: ROLE_DEFINITIONS[role].rank,
});

const ctx = { ip: null, userAgent: null, correlationId: null };

function build(opts: {
  holders: number;
  txError?: unknown;
  actorStatus?: string;
}) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  // `holders` = every ACTIVE holder including the target; the service counts the OTHERS
  const count = vi.fn().mockResolvedValue(opts.holders - 1);
  const tx = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ status: opts.actorStatus ?? 'ACTIVE' }),
    },
    userRole: { count, deleteMany },
  };
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'target',
        status: 'ACTIVE',
        roles: [{ role: { rank: 100 } }],
      }),
    },
    role: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'r',
        name: 'SUPER_ADMIN',
        rank: 100,
        permissions: [],
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => {
      if (opts.txError) throw opts.txError;
      return fn(tx);
    }),
  };
  const authz = { invalidate: vi.fn() };
  const sessions = { revokeAllForUser: vi.fn() };
  const audit = { record: vi.fn() };
  const svc = new AdminAccessService(
    prisma as never,
    authz as never,
    sessions as never,
    audit as never,
  );
  return { svc, deleteMany, sessions, authz, audit, count };
}

describe('AdminAccessService.revokeRole (SUPER_ADMIN safety)', () => {
  it('refuses to remove the LAST SUPER_ADMIN and changes nothing', async () => {
    const { svc, deleteMany, sessions, audit } = build({ holders: 1 });
    await expect(
      svc.revokeRole(
        principal('actor', 'SUPER_ADMIN'),
        'target',
        'SUPER_ADMIN',
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.role.revoked' }),
    );
  });

  it("allows removal when another SUPER_ADMIN remains, then ends the target's sessions and audits", async () => {
    const { svc, deleteMany, sessions, authz, audit } = build({ holders: 2 });
    await svc.revokeRole(
      principal('actor', 'SUPER_ADMIN'),
      'target',
      'SUPER_ADMIN',
      ctx,
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(authz.invalidate).toHaveBeenCalledWith('target');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      'target',
      'ROLE_REVOKED',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access.role.revoked',
        actorId: 'actor',
      }),
    );
  });

  it.each([
    [
      'Prisma P2034',
      Object.assign(new Error('write conflict'), { code: 'P2034' }),
    ],
    [
      'driver TransactionWriteConflict',
      Object.assign(new Error('x'), {
        cause: { kind: 'TransactionWriteConflict' },
      }),
    ],
    [
      'Postgres 40001',
      Object.assign(new Error('could not serialize access'), {
        cause: { originalCode: '40001' },
      }),
    ],
  ])(
    'turns a serialization conflict (%s) into a retryable 409, not a 500',
    async (_n, txError) => {
      const { svc } = build({ holders: 2, txError });
      await expect(
        svc.revokeRole(
          principal('actor', 'SUPER_ADMIN'),
          'target',
          'SUPER_ADMIN',
          ctx,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it('does not swallow unrelated errors', async () => {
    const { svc } = build({
      holders: 2,
      txError: new Error('connection reset'),
    });
    await expect(
      svc.revokeRole(
        principal('actor', 'SUPER_ADMIN'),
        'target',
        'SUPER_ADMIN',
        ctx,
      ),
    ).rejects.toThrow('connection reset');
  });

  it('enforces the rank policy before touching the database', async () => {
    const { svc, deleteMany } = build({ holders: 5 });
    // an ADMIN may not revoke a SUPER_ADMIN role (target ranks above the actor)
    await expect(
      svc.revokeRole(principal('actor', 'ADMIN'), 'target', 'SUPER_ADMIN', ctx),
    ).rejects.toThrow('permission');
    expect(deleteMany).not.toHaveBeenCalled();
    expect(Permission.UsersManage).toBe('users.manage');
  });
});

describe('AdminAccessService.revokeRole (active holders, active actor)', () => {
  const root = principal('actor', 'SUPER_ADMIN');
  it('counts only ACTIVE holders other than the target (a suspended SUPER_ADMIN does not count)', async () => {
    const { svc, count } = build({ holders: 2 });
    await svc.revokeRole(root, 'target', 'SUPER_ADMIN', ctx);
    expect(count).toHaveBeenCalledWith({
      where: {
        roleId: 'r',
        userId: { not: 'target' },
        user: { status: 'ACTIVE' },
      },
    });
  });

  it('an actor who was suspended meanwhile cannot revoke anything', async () => {
    const { svc, deleteMany } = build({ holders: 5, actorStatus: 'SUSPENDED' });
    await expect(
      svc.revokeRole(root, 'target', 'SUPER_ADMIN', ctx),
    ).rejects.toThrow(/permission/);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('AdminAccessService.setStatus (SUPER_ADMIN safety)', () => {
  function buildStatus(opts: {
    actorStatus?: string;
    otherActiveSuperAdmins: number;
    targetIsSuperAdmin: boolean;
    txError?: unknown;
  }) {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ status: opts.actorStatus ?? 'ACTIVE' }),
        update,
      },
      userRole: {
        count: vi
          .fn()
          .mockImplementation((args: { where: { userId?: unknown } }) =>
            Promise.resolve(
              typeof args.where.userId === 'string'
                ? opts.targetIsSuperAdmin
                  ? 1
                  : 0
                : opts.otherActiveSuperAdmins,
            ),
          ),
      },
    };
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'target',
          status: 'ACTIVE',
          roles: [{ role: { rank: 100 } }],
        }),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => {
        if (opts.txError) throw opts.txError;
        return fn(tx);
      }),
    };
    const sessions = { revokeAllForUser: vi.fn() };
    const svc = new AdminAccessService(
      prisma as never,
      { invalidate: vi.fn() } as never,
      sessions as never,
      { record: vi.fn() } as never,
    );
    return { svc, update, sessions, prisma };
  }
  const root = principal('actor', 'SUPER_ADMIN');

  it('refuses to suspend the last ACTIVE SUPER_ADMIN, inside a serializable transaction', async () => {
    const { svc, update, sessions, prisma } = buildStatus({
      otherActiveSuperAdmins: 0,
      targetIsSuperAdmin: true,
    });
    await expect(
      svc.setStatus(root, 'target', 'SUSPENDED', undefined, ctx),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('allows it while another active SUPER_ADMIN remains, and ends the target sessions', async () => {
    const { svc, update, sessions } = buildStatus({
      otherActiveSuperAdmins: 1,
      targetIsSuperAdmin: true,
    });
    await svc.setStatus(root, 'target', 'SUSPENDED', 'left', ctx);
    expect(update).toHaveBeenCalledOnce();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      'target',
      'SUSPENDED',
    );
  });

  it('an actor who was suspended meanwhile cannot suspend anyone', async () => {
    const { svc, update } = buildStatus({
      actorStatus: 'SUSPENDED',
      otherActiveSuperAdmins: 5,
      targetIsSuperAdmin: false,
    });
    await expect(
      svc.setStatus(root, 'target', 'SUSPENDED', undefined, ctx),
    ).rejects.toThrow(/permission/);
    expect(update).not.toHaveBeenCalled();
  });

  it('a serialization conflict (two admins at once) is a clean 409', async () => {
    const { svc } = buildStatus({
      otherActiveSuperAdmins: 1,
      targetIsSuperAdmin: true,
      txError: Object.assign(new Error('could not serialize'), {
        code: 'P2034',
      }),
    });
    await expect(
      svc.setStatus(root, 'target', 'SUSPENDED', undefined, ctx),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
