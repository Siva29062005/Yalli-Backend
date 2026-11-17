import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';
import { EphemeralStore } from '../../../infrastructure/cache/ephemeral-store.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import type { AuthPrincipal } from '../../../common/auth/auth-principal.js';
import { AuditAction } from '../../audit/audit-actions.js';
import {
  AuditService,
  type RequestContext,
} from '../../audit/audit.service.js';
import { generateToken, sha256Hex } from '../crypto/token-utils.js';
import { PasswordService } from '../crypto/password.service.js';
import type { LoginDto } from '../dto/auth.schemas.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import { NotificationPort } from '../ports/ports.js';
import {
  addDays,
  addMinutes,
  apiError,
  deviceHash,
  displayName,
  invalidCredentials,
  normalizeEmail,
} from './identity-utils.js';
import { SessionStateService } from './session-state.service.js';

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

export type LoginResult =
  | ({ kind: 'tokens' } & SessionTokens)
  | { kind: 'mfa'; mfaToken: string; expiresIn: number };

const LOCK_THRESHOLD = 5;
const LOCK_BASE_MINUTES = 15;
// An unauthenticated caller can trigger a lock on any account, so the ceiling is deliberately short: long enough to make
// guessing pointless (together with the per-email and per-IP rate limits), short enough that it is a nuisance, not an outage.
const LOCK_MAX_MINUTES = 60;
const MFA_CHALLENGE_TTL = 300;
const mfaKey = (hash: string) => `mfa:challenge:${hash}`;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly absoluteDays: number;
  private readonly idleDays: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStateService,
    private readonly store: EphemeralStore,
    private readonly notifications: NotificationPort,
    private readonly audit: AuditService,
  ) {
    this.absoluteDays = config.get('REFRESH_ABSOLUTE_TTL_DAYS', {
      infer: true,
    });
    this.idleDays = config.get('REFRESH_IDLE_TTL_DAYS', { infer: true });
  }

  // ---------------------------------------------------------------------------------------- login

  async login(dto: LoginDto, ctx: RequestContext): Promise<LoginResult> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: email },
      include: { customer: { select: { firstName: true, lastName: true } } },
    });

    // Unknown / deleted / currently locked: burn equivalent CPU and answer identically. A locked account is
    // not even tested against the password, so lockout cannot be used as a guessing oracle.
    if (!user || user.status === 'DELETED') {
      await this.passwords.verifyDummy(dto.password);
      await this.audit.record({
        action: AuditAction.LoginFailure,
        outcome: 'FAILURE',
        ...ctx,
        metadata: { reason: 'unknown_account' },
      });
      throw invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.passwords.verifyDummy(dto.password);
      await this.audit.record({
        action: AuditAction.LoginBlockedLocked,
        outcome: 'DENIED',
        actorId: user.id,
        ...ctx,
      });
      throw invalidCredentials();
    }

    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      await this.registerFailure(
        user.id,
        user.email,
        displayName(user.customer),
        ctx,
      );
      throw invalidCredentials();
    }

    // Credentials are correct: it is now safe to tell the owner WHY they cannot proceed.
    if (user.status === 'PENDING_VERIFICATION') {
      throw apiError(
        403,
        ErrorCode.EmailNotVerified,
        'Please verify your email address to sign in',
      );
    }
    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        action: AuditAction.LoginBlockedStatus,
        outcome: 'DENIED',
        actorId: user.id,
        ...ctx,
        metadata: { status: user.status },
      });
      throw apiError(
        403,
        ErrorCode.AccountSuspended,
        'This account is currently unavailable. Please contact support.',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(this.passwords.needsRehash(user.passwordHash)
          ? { passwordHash: await this.passwords.hash(dto.password) }
          : {}),
      },
    });

    if (user.mfaEnabled) return this.startMfaChallenge(user.id, ctx);

    const tokens = await this.createSession(
      user.id,
      user.email,
      displayName(user.customer),
      ctx,
      { mfaVerified: false, deviceLabel: dto.deviceLabel },
    );
    return { kind: 'tokens', ...tokens };
  }

  private async registerFailure(
    userId: string,
    email: string,
    name: string,
    ctx: RequestContext,
  ): Promise<void> {
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } }, // atomic: concurrent guesses cannot undercount
      select: { failedLoginCount: true },
    });
    await this.audit.record({
      action: AuditAction.LoginFailure,
      outcome: 'FAILURE',
      actorId: userId,
      ...ctx,
      metadata: { reason: 'bad_password', failures: failedLoginCount },
    });
    if (
      failedLoginCount >= LOCK_THRESHOLD &&
      failedLoginCount % LOCK_THRESHOLD === 0
    ) {
      const level = failedLoginCount / LOCK_THRESHOLD - 1;
      const minutes = Math.min(
        LOCK_BASE_MINUTES * 2 ** level,
        LOCK_MAX_MINUTES,
      );
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: addMinutes(new Date(), minutes) },
      });
      await this.audit.record({
        action: AuditAction.AccountLocked,
        outcome: 'SUCCESS',
        actorId: userId,
        ...ctx,
        metadata: { minutes },
      });
      await this.notifications
        .send({ type: 'ACCOUNT_LOCKED', email, name, minutes })
        .catch((err) => this.logger.error({ err }, 'Lock notice failed'));
    }
  }

  // ------------------------------------------------------------------------------- MFA challenge

  private async startMfaChallenge(
    userId: string,
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const mfaToken = generateToken();
    await this.store.set(
      mfaKey(sha256Hex(mfaToken)),
      JSON.stringify({ userId, ip: ctx.ip }),
      MFA_CHALLENGE_TTL,
    );
    return { kind: 'mfa', mfaToken, expiresIn: MFA_CHALLENGE_TTL };
  }

  /** Returns the user a valid, unexpired challenge belongs to, enforcing a per-challenge attempt cap. */
  async resolveMfaChallenge(
    mfaToken: string,
  ): Promise<{ userId: string; consume: () => Promise<void> }> {
    const hash = sha256Hex(mfaToken);
    const raw = await this.store.get(mfaKey(hash));
    if (!raw)
      throw new UnauthorizedException({
        message: 'Invalid or expired verification',
        code: ErrorCode.Unauthorized,
      });
    const { count } = await this.store.incr(
      `mfa:attempts:${hash}`,
      MFA_CHALLENGE_TTL,
    );
    if (count > 5) {
      await this.store.del(mfaKey(hash));
      throw new UnauthorizedException({
        message: 'Invalid or expired verification',
        code: ErrorCode.Unauthorized,
      });
    }
    return {
      userId: (JSON.parse(raw) as { userId: string }).userId,
      consume: () => this.store.del(mfaKey(hash), `mfa:attempts:${hash}`),
    };
  }

  async completeMfaLogin(
    userId: string,
    ctx: RequestContext,
  ): Promise<SessionTokens> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { customer: { select: { firstName: true, lastName: true } } },
    });
    if (user?.status !== 'ACTIVE') throw invalidCredentials();
    return this.createSession(
      user.id,
      user.email,
      displayName(user.customer),
      ctx,
      { mfaVerified: true },
    );
  }

  // ----------------------------------------------------------------------------------- sessions

  async createSession(
    userId: string,
    email: string,
    name: string,
    ctx: RequestContext,
    opts: { mfaVerified: boolean; deviceLabel?: string | undefined },
  ): Promise<SessionTokens> {
    const hash = deviceHash(ctx.userAgent);
    const [priorSessions, knownDevice] = await Promise.all([
      this.prisma.userSession.count({ where: { userId } }),
      this.prisma.userSession.count({ where: { userId, deviceHash: hash } }),
    ]);

    const now = new Date();
    const sessionExpiry = addDays(now, this.absoluteDays);
    const refreshToken = generateToken();
    const refreshExpiresAt = new Date(
      Math.min(addDays(now, this.idleDays).getTime(), sessionExpiry.getTime()),
    );

    const session = await this.prisma.userSession.create({
      data: {
        userId,
        deviceLabel: opts.deviceLabel ?? null,
        userAgent: ctx.userAgent,
        deviceHash: hash,
        ip: ctx.ip,
        expiresAt: sessionExpiry,
        mfaVerified: opts.mfaVerified,
        authenticatedAt: now,
        refreshTokens: {
          create: {
            tokenHash: sha256Hex(refreshToken),
            expiresAt: refreshExpiresAt,
          },
        },
      },
      select: { id: true },
    });

    const accessToken = await this.tokens.sign({
      userId,
      sessionId: session.id,
      amr: opts.mfaVerified ? ['pwd', 'otp'] : ['pwd'],
      authTime: Math.floor(now.getTime() / 1000),
    });

    await this.audit.record({
      action: AuditAction.LoginSuccess,
      outcome: 'SUCCESS',
      actorId: userId,
      ...ctx,
      resourceType: 'session',
      resourceId: session.id,
      metadata: { mfa: opts.mfaVerified },
    });
    if (priorSessions > 0 && knownDevice === 0) {
      await this.audit.record({
        action: AuditAction.LoginNewDevice,
        outcome: 'SUCCESS',
        actorId: userId,
        ...ctx,
        resourceType: 'session',
        resourceId: session.id,
      });
      await this.notifications
        .send({
          type: 'NEW_DEVICE_LOGIN',
          email,
          name,
          device: opts.deviceLabel ?? 'a new device',
          ip: ctx.ip,
        })
        .catch((err) => this.logger.error({ err }, 'New-device alert failed'));
    }
    return {
      accessToken,
      expiresIn: this.tokens.ttlSeconds,
      refreshToken,
      refreshExpiresAt,
      sessionId: session.id,
    };
  }

  /**
   * Rotates a refresh token. A token that was already used is evidence of theft (or a replayed copy): the whole
   * session is revoked, forcing re-authentication everywhere that session was used.
   */
  async refresh(rawToken: string, ctx: RequestContext): Promise<SessionTokens> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      include: {
        session: {
          include: {
            user: {
              include: {
                customer: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
      },
    });
    const reject = async (reason: string, userId?: string): Promise<never> => {
      await this.audit.record({
        action: AuditAction.RefreshRejected,
        outcome: 'DENIED',
        actorId: userId,
        ...ctx,
        metadata: { reason },
      });
      throw new UnauthorizedException({
        message: 'Session expired. Please sign in again.',
        code: ErrorCode.Unauthorized,
      });
    };
    if (!row) return reject('unknown_token');

    const { session } = row;
    const user = session.user;
    const now = new Date();

    if (row.usedAt) return this.handleReuse(row.sessionId, user, ctx);
    if (session.revokedAt || session.expiresAt <= now || row.expiresAt <= now)
      return reject('expired_or_revoked', user.id);
    if (user.status !== 'ACTIVE') return reject('user_inactive', user.id);

    // Atomic claim: if two requests race with the same token, exactly one wins and the loser is treated as reuse.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return this.handleReuse(row.sessionId, user, ctx);

    const next = generateToken();
    const refreshExpiresAt = new Date(
      Math.min(
        addDays(now, this.idleDays).getTime(),
        session.expiresAt.getTime(),
      ),
    );
    await this.prisma.$transaction([
      this.prisma.refreshToken.create({
        data: {
          sessionId: session.id,
          tokenHash: sha256Hex(next),
          expiresAt: refreshExpiresAt,
        },
      }),
      this.prisma.userSession.update({
        where: { id: session.id },
        data: { lastSeenAt: now, ip: ctx.ip ?? session.ip },
      }),
    ]);

    const accessToken = await this.tokens.sign({
      userId: user.id,
      sessionId: session.id,
      amr: session.mfaVerified ? ['pwd', 'otp'] : ['pwd'],
      authTime: Math.floor(session.authenticatedAt.getTime() / 1000),
    });
    await this.audit.record({
      action: AuditAction.RefreshRotated,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
      resourceType: 'session',
      resourceId: session.id,
    });
    return {
      accessToken,
      expiresIn: this.tokens.ttlSeconds,
      refreshToken: next,
      refreshExpiresAt,
      sessionId: session.id,
    };
  }

  private async handleReuse(
    sessionId: string,
    user: {
      id: string;
      email: string;
      customer: { firstName: string; lastName: string } | null;
    },
    ctx: RequestContext,
  ): Promise<never> {
    await this.sessions.revoke(
      [{ id: sessionId, userId: user.id }],
      'REFRESH_REUSE',
    );
    await this.audit.record({
      action: AuditAction.RefreshReuseDetected,
      outcome: 'DENIED',
      actorId: user.id,
      ...ctx,
      resourceType: 'session',
      resourceId: sessionId,
    });
    await this.notifications
      .send({
        type: 'SESSION_THEFT_SUSPECTED',
        email: user.email,
        name: displayName(user.customer),
      })
      .catch((err) => this.logger.error({ err }, 'Reuse alert failed'));
    throw new UnauthorizedException({
      message: 'Session expired. Please sign in again.',
      code: ErrorCode.Unauthorized,
    });
  }

  async logout(principal: AuthPrincipal, ctx: RequestContext): Promise<void> {
    await this.sessions.revoke(
      [{ id: principal.sessionId, userId: principal.userId }],
      'LOGOUT',
    );
    await this.audit.record({
      action: AuditAction.Logout,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'session',
      resourceId: principal.sessionId,
    });
  }

  async logoutAll(
    principal: AuthPrincipal,
    ctx: RequestContext,
  ): Promise<number> {
    const count = await this.sessions.revokeAllForUser(
      principal.userId,
      'LOGOUT_ALL',
    );
    await this.audit.record({
      action: AuditAction.LogoutAll,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      metadata: { sessions: count },
    });
    return count;
  }

  async listSessions(principal: AuthPrincipal) {
    const rows = await this.prisma.userSession.findMany({
      where: {
        userId: principal.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceLabel: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastSeenAt: true,
      },
      take: 100,
    });
    return rows.map((s) => ({ ...s, current: s.id === principal.sessionId }));
  }

  /** Ownership is enforced IN the query: another user's session id is indistinguishable from a missing one (404). */
  async revokeOwnSession(
    principal: AuthPrincipal,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId: principal.userId, revokedAt: null },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    await this.sessions.revoke(
      [{ id: session.id, userId: principal.userId }],
      'USER_REVOKED',
    );
    await this.audit.record({
      action: AuditAction.SessionRevoked,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'session',
      resourceId: session.id,
    });
  }
}
