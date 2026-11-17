import { Injectable } from '@nestjs/common';
import { EphemeralStore } from '../../infrastructure/cache/ephemeral-store.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export interface UserAccess {
  status: string;
  roles: { name: string; rank: number; permissions: string[] }[];
  permissions: string[];
  maxRank: number;
}

const TTL_SECONDS = 60;
const key = (userId: string) => `authz:v1:${userId}`;

/**
 * Resolves what a user may do FROM THE DATABASE (cached briefly in Redis).
 * Nothing about roles/permissions is ever read from the client or from the access token.
 * Call `invalidate` after any role / status change so the change applies immediately.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: EphemeralStore,
  ) {}

  async loadAccess(userId: string): Promise<UserAccess | null> {
    const cached = await this.store.get(key(userId)).catch(() => null);
    if (cached) return JSON.parse(cached) as UserAccess;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
                rank: true,
                permissions: {
                  select: { permission: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!user) return null;

    const roles = user.roles.map(({ role }) => ({
      name: role.name,
      rank: role.rank,
      permissions: role.permissions.map((rp) => rp.permission.name),
    }));
    const access: UserAccess = {
      status: user.status,
      roles,
      permissions: [...new Set(roles.flatMap((r) => r.permissions))],
      maxRank: roles.reduce((max, r) => Math.max(max, r.rank), 0),
    };
    await this.store
      .set(key(userId), JSON.stringify(access), TTL_SECONDS)
      .catch(() => undefined);
    return access;
  }

  async invalidate(userId: string): Promise<void> {
    await this.store.del(key(userId));
  }
}
