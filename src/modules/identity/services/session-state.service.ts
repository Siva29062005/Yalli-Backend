import { Injectable } from '@nestjs/common';
import { EphemeralStore } from '../../../infrastructure/cache/ephemeral-store.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuthorizationService } from '../../access/authorization.service.js';
import { AccessTokenService } from '../jwt/access-token.service.js';

const OK_TTL = 30;
const revokedKey = (sid: string) => `sess:revoked:${sid}`;
const okKey = (sid: string, uid: string) => `sess:ok:${sid}:${uid}`;

/**
 * Makes revocation effective immediately: access tokens are stateless, so each request also checks that the
 * session is still alive (revocation flag first, short-lived positive cache, database as the source of truth).
 */
@Injectable()
export class SessionStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: EphemeralStore,
    private readonly tokens: AccessTokenService,
    private readonly authz: AuthorizationService,
  ) {}

  async isActive(sessionId: string, userId: string): Promise<boolean> {
    if (await this.store.get(revokedKey(sessionId))) return false;
    if (await this.store.get(okKey(sessionId, userId))) return true;
    const session = await this.prisma.userSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) return false;
    await this.store.set(okKey(sessionId, userId), '1', OK_TTL);
    return true;
  }

  /** Revoke specific sessions (ownership is the CALLER's responsibility - scope the ids to the actor's user). */
  async revoke(
    sessions: { id: string; userId: string }[],
    reason: string,
  ): Promise<void> {
    if (sessions.length === 0) return;
    const ids = sessions.map((s) => s.id);
    await this.prisma.userSession.updateMany({
      where: { id: { in: ids }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    // The flag outlives the longest possible access token, so a revoked session's tokens die everywhere at once.
    await Promise.all(
      sessions.map((s) =>
        this.store.set(revokedKey(s.id), '1', this.tokens.ttlSeconds + 60),
      ),
    );
    await this.store.del(...sessions.map((s) => okKey(s.id, s.userId)));
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const live = await this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true, userId: true },
    });
    await this.revoke(live, reason);
    return live.length;
  }

  /** Immediate effect for suspensions / role changes: drop the cached permission snapshot too. */
  async invalidateUser(userId: string): Promise<void> {
    await this.authz.invalidate(userId);
  }
}
