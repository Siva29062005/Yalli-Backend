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

function build(opts: { holders: number; txError?: unknown }) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    userRole: { count: vi.fn().mockResolvedValue(opts.holders), deleteMany },
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
  return { svc, deleteMany, sessions, authz, audit };
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
