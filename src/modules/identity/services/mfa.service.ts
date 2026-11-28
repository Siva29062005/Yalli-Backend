import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verifySync } from 'otplib';
import type { Env } from '../../../config/env.js';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';
import type { AuthPrincipal } from '../../../common/auth/auth-principal.js';
import { EphemeralStore } from '../../../infrastructure/cache/ephemeral-store.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { STAFF_ROLE_RANK_THRESHOLD } from '../../access/permissions.js';
import { AuditAction } from '../../audit/audit-actions.js';
import {
  AuditService,
  type RequestContext,
} from '../../audit/audit.service.js';
import { PasswordService } from '../crypto/password.service.js';
import { SecretBox } from '../crypto/secret-box.service.js';
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  sha256Hex,
} from '../crypto/token-utils.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import { NotificationPort } from '../ports/ports.js';
import { apiError, displayName } from './identity-utils.js';
import { SessionStateService } from './session-state.service.js';

const RECOVERY_CODE_COUNT = 10;
/** +/- one 30s step of clock drift. */
const TOTP_TOLERANCE_SECONDS = 30;
const TOTP_PERIOD_SECONDS = 30;

/**
 * Checks a TOTP code against a fixed clock reading and returns the time-step it matched (or null).
 * The epoch is captured ONCE so the step arithmetic cannot straddle a period boundary.
 */
function matchTotpStep(
  secret: string,
  token: string,
  afterStep?: number,
): number | null {
  const epoch = Math.floor(Date.now() / 1000);
  const result = verifySync({
    secret,
    token,
    epoch,
    epochTolerance: TOTP_TOLERANCE_SECONDS,
    ...(afterStep === undefined ? {} : { afterTimeStep: afterStep }),
  });
  return result.valid
    ? Math.floor(epoch / TOTP_PERIOD_SECONDS) + result.delta
    : null;
}

/** Wrong second-factor attempts allowed per account per window, across all logins and devices. */
export const MFA_FAIL_LIMIT = 10;
export const MFA_FAIL_WINDOW_SECONDS = 15 * 60;
/**
 * A daily cap on top: the 15-minute window alone allowed about 960 guesses a day (an 8% chance a month with a known
 * password). With 30 a day the chance is under 0.1% a month.
 */
export const MFA_DAILY_FAIL_LIMIT = 30;
export const MFA_DAILY_FAIL_WINDOW_SECONDS = 24 * 3600;
const dayLockKey = (userId: string) => `mfa:lock:day:${userId}`;

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly issuer: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly box: SecretBox,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStateService,
    private readonly notifications: NotificationPort,
    private readonly audit: AuditService,
    private readonly store: EphemeralStore,
  ) {
    this.issuer = config.get('MFA_ISSUER', { infer: true });
  }

  private async requireUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { customer: { select: { firstName: true, lastName: true } } },
    });
    if (!user) throw new NotFoundException();
    return user;
  }

  private async requirePassword(
    user: { id: string; passwordHash: string },
    password: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.audit.record({
        action: AuditAction.LoginFailure,
        outcome: 'FAILURE',
        actorId: user.id,
        ...ctx,
        metadata: { reason: 'reauth_bad_password' },
      });
      throw new UnauthorizedException({
        message: 'Incorrect password',
        code: ErrorCode.Unauthorized,
      });
    }
  }

  // ---------------------------------------------------------------------------------- enrolment

  async enroll(
    principal: AuthPrincipal,
    password: string,
    ctx: RequestContext,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.requireUser(principal.userId);
    await this.requirePassword(user, password, ctx);
    if (user.mfaEnabled)
      throw new ConflictException({
        message: 'Multi-factor authentication is already enabled',
        code: ErrorCode.Conflict,
      });

    const secret = generateSecret();
    await this.prisma.$transaction([
      this.prisma.mfaMethod.deleteMany({
        where: { userId: user.id, status: 'PENDING' },
      }),
      this.prisma.mfaMethod.create({
        data: {
          userId: user.id,
          secretEnc: this.box.encrypt(secret, `mfa:${user.id}`),
          status: 'PENDING',
        },
      }),
    ]);
    await this.audit.record({
      action: AuditAction.MfaEnrollStarted,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
    return {
      secret,
      otpauthUri: generateURI({
        issuer: this.issuer,
        label: user.email,
        secret,
      }),
    };
  }

  /** Activates MFA after the user proves their authenticator works. Returns the recovery codes (shown once). */
  async confirm(
    principal: AuthPrincipal,
    code: string,
    ctx: RequestContext,
  ): Promise<string[]> {
    const user = await this.requireUser(principal.userId);
    const pending = await this.prisma.mfaMethod.findFirst({
      where: { userId: user.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) throw new NotFoundException('No enrolment in progress');

    const step = matchTotpStep(
      this.box.decrypt(pending.secretEnc, `mfa:${user.id}`),
      code,
    );
    if (step === null)
      throw apiError(
        400,
        ErrorCode.ValidationFailed,
        'The code is incorrect or expired',
      );

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    await this.prisma.$transaction([
      this.prisma.mfaMethod.updateMany({
        where: { userId: user.id, status: 'ACTIVE' },
        data: { status: 'PENDING' },
      }),
      this.prisma.mfaMethod.update({
        where: { id: pending.id },
        data: {
          status: 'ACTIVE',
          confirmedAt: new Date(),
          lastUsedStep: BigInt(step),
        },
      }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.mfaRecoveryCode.createMany({
        data: codes.map((c) => ({
          userId: user.id,
          codeHash: sha256Hex(normalizeRecoveryCode(c)),
        })),
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { mfaEnabled: true },
      }),
    ]);
    // Sessions opened with the password alone predate the second factor: sign every OTHER device out (as a password
    // change does), so a thief who already had a session does not keep it.
    await this.sessions.revokeAllForUser(
      user.id,
      'MFA_ENABLED',
      principal.sessionId,
    );
    await this.audit.record({
      action: AuditAction.MfaEnabled,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
    await this.notifications
      .send({
        type: 'MFA_ENABLED',
        email: user.email,
        name: displayName(user.customer),
      })
      .catch((e) => this.logger.error({ err: e }, 'MFA notice failed'));
    return codes;
  }

  // ------------------------------------------------------------------------------ verification

  /** Verifies a TOTP code. A code can be used only once: its time-step must be newer than the last accepted one. */
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const method = await this.prisma.mfaMethod.findFirst({
      where: { userId, status: 'ACTIVE' },
    });
    if (!method) return false;
    const last =
      method.lastUsedStep === null ? undefined : Number(method.lastUsedStep);
    const step = matchTotpStep(
      this.box.decrypt(method.secretEnc, `mfa:${userId}`),
      code,
      last,
    );
    if (step === null) return false;
    // Atomic replay guard: only the first request to claim this time-step wins (also under concurrency).
    const claimed = await this.prisma.mfaMethod.updateMany({
      where: {
        id: method.id,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
      },
      data: { lastUsedStep: BigInt(step) },
    });
    return claimed.count === 1;
  }

  async verifyRecoveryCode(
    userId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    const res = await this.prisma.mfaRecoveryCode.updateMany({
      where: {
        userId,
        codeHash: sha256Hex(normalizeRecoveryCode(code)),
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    if (res.count === 1)
      await this.audit.record({
        action: AuditAction.MfaRecoveryCodeUsed,
        outcome: 'SUCCESS',
        actorId: userId,
        ...ctx,
      });
    return res.count === 1;
  }

  async verifySecondFactor(
    userId: string,
    factor: { code?: string | undefined; recoveryCode?: string | undefined },
    ctx: RequestContext,
  ): Promise<boolean> {
    // Cumulative per-ACCOUNT limit across every challenge, login and device: a stolen password plus unlimited fresh logins
    // must not become an unlimited number of code guesses. Every attempt is counted atomically BEFORE it is checked and the
    // counter is cleared only by a success, so concurrent guesses cannot slip past the limit.
    const failKey = `mfa:fail:${userId}`;
    const [win, dayLock] = await Promise.all([
      this.store.incr(failKey, MFA_FAIL_WINDOW_SECONDS),
      this.store.get(dayLockKey(userId)),
    ]);
    const overWindow = win.count > MFA_FAIL_LIMIT;
    const dayUntil = dayLock ? Number(dayLock) : 0;
    const overDay = dayUntil > Date.now();
    if (overWindow || overDay) {
      // the first refusal of the 15-minute lock: audited, and the owner is told
      if (overWindow && win.count === MFA_FAIL_LIMIT + 1)
        await this.lockStarted(userId, 'window', ctx);
      throw apiError(
        429,
        ErrorCode.TooManyRequests,
        'Too many incorrect codes. Please try again later.',
        {
          retryAfterSeconds: Math.max(
            overWindow ? win.ttlSeconds : 0,
            overDay ? Math.ceil((dayUntil - Date.now()) / 1000) : 0,
          ),
        },
      );
    }
    const ok = factor.code
      ? await this.verifyTotp(userId, factor.code)
      : factor.recoveryCode
        ? await this.verifyRecoveryCode(userId, factor.recoveryCode, ctx)
        : false;
    if (ok) {
      await this.store.del(failKey); // only FAILURES count towards the daily cap: a correct code leaves it alone
    } else {
      await this.audit.record({
        action: AuditAction.MfaChallengeFailed,
        outcome: 'FAILURE',
        actorId: userId,
        ...ctx,
      });
      const day = await this.store.incr(
        `mfa:fail:day:${userId}`,
        MFA_DAILY_FAIL_WINDOW_SECONDS,
      );
      if (day.count === MFA_DAILY_FAIL_LIMIT) {
        // the daily lock starts now and lasts until the day window ends; the marker holds its end for Retry-After
        await this.store.set(
          dayLockKey(userId),
          String(Date.now() + day.ttlSeconds * 1000),
          day.ttlSeconds,
        );
        await this.lockStarted(userId, 'day', ctx);
      }
    }
    return ok;
  }

  /** A lock starts: audited once, and the owner is emailed (wrong codes on their account). */
  private async lockStarted(
    userId: string,
    scope: 'window' | 'day',
    ctx: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      action: AuditAction.MfaLocked,
      outcome: 'DENIED',
      actorId: userId,
      ...ctx,
      metadata: { scope },
    });
    await this.alertOwner(userId);
  }

  /**
   * Clears every code-failure counter and lock. Called when a password reset completes: the mailbox owner is back in
   * control (and whoever held the old password lost it), so they must not stay locked out of their own account.
   */
  async clearFailures(userId: string): Promise<void> {
    await this.store.del(
      `mfa:fail:${userId}`,
      `mfa:fail:day:${userId}`,
      dayLockKey(userId),
    );
  }

  /** Best-effort security email (never throws): an account-security alert must not break the sign-in answer. */
  private async alertOwner(userId: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      });
      if (!user) return;
      await this.notifications.send({
        type: 'MFA_LOCKED',
        email: user.email,
        name: displayName(user.customer),
      });
    } catch (err) {
      this.logger.error({ err: (err as Error).name }, 'MFA lock alert failed');
    }
  }

  // ------------------------------------------------------------------------------- management

  async disable(
    principal: AuthPrincipal,
    input: {
      password: string;
      code?: string | undefined;
      recoveryCode?: string | undefined;
    },
    ctx: RequestContext,
  ): Promise<void> {
    if (principal.maxRank >= STAFF_ROLE_RANK_THRESHOLD) {
      throw new ForbiddenException({
        message: 'Multi-factor authentication is mandatory for staff accounts',
        code: ErrorCode.Forbidden,
      });
    }
    const user = await this.requireUser(principal.userId);
    await this.requirePassword(user, input.password, ctx);
    if (!(await this.verifySecondFactor(user.id, input, ctx)))
      throw apiError(
        401,
        ErrorCode.Unauthorized,
        'The code is incorrect or expired',
      );

    await this.prisma.$transaction([
      this.prisma.mfaMethod.deleteMany({ where: { userId: user.id } }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false },
      }),
    ]);
    await this.sessions.revokeAllForUser(
      user.id,
      'MFA_DISABLED',
      principal.sessionId,
    );
    await this.audit.record({
      action: AuditAction.MfaDisabled,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
    await this.notifications
      .send({
        type: 'MFA_DISABLED',
        email: user.email,
        name: displayName(user.customer),
      })
      .catch((e) => this.logger.error({ err: e }, 'MFA notice failed'));
  }

  async regenerateRecoveryCodes(
    principal: AuthPrincipal,
    code: string,
    ctx: RequestContext,
  ): Promise<string[]> {
    if (!(await this.verifySecondFactor(principal.userId, { code }, ctx)))
      throw apiError(
        401,
        ErrorCode.Unauthorized,
        'The code is incorrect or expired',
      );
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    await this.prisma.$transaction([
      this.prisma.mfaRecoveryCode.deleteMany({
        where: { userId: principal.userId },
      }),
      this.prisma.mfaRecoveryCode.createMany({
        data: codes.map((c) => ({
          userId: principal.userId,
          codeHash: sha256Hex(normalizeRecoveryCode(c)),
        })),
      }),
    ]);
    await this.audit.record({
      action: AuditAction.MfaRecoveryCodesRegenerated,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
    });
    return codes;
  }

  /** Re-authenticates an existing session with a fresh TOTP so sensitive actions (admin, role changes) are allowed. */
  async stepUp(
    principal: AuthPrincipal,
    code: string,
    ctx: RequestContext,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    if (!(await this.verifySecondFactor(principal.userId, { code }, ctx)))
      throw apiError(
        401,
        ErrorCode.Unauthorized,
        'The code is incorrect or expired',
      );
    const now = new Date();
    await this.prisma.userSession.updateMany({
      where: {
        id: principal.sessionId,
        userId: principal.userId,
        revokedAt: null,
      },
      data: { mfaVerified: true, authenticatedAt: now },
    });
    await this.audit.record({
      action: AuditAction.StepUpSuccess,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'session',
      resourceId: principal.sessionId,
    });
    const accessToken = await this.tokens.sign({
      userId: principal.userId,
      sessionId: principal.sessionId,
      amr: ['pwd', 'otp'],
      authTime: Math.floor(now.getTime() / 1000),
    });
    return { accessToken, expiresIn: this.tokens.ttlSeconds };
  }
}
