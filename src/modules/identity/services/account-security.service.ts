import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { AuthPrincipal } from '../../../common/auth/auth-principal.js';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../../audit/audit-actions.js';
import {
  AuditService,
  type RequestContext,
} from '../../audit/audit.service.js';
import { passwordViolations } from '../crypto/password-policy.js';
import { PasswordService } from '../crypto/password.service.js';
import {
  BreachedPasswordChecker,
  CaptchaVerifier,
  NotificationPort,
} from '../ports/ports.js';
import {
  apiError,
  displayName,
  invalidCredentials,
  isUniqueViolation,
  normalizeEmail,
} from './identity-utils.js';
import { SessionStateService } from './session-state.service.js';
import { VerificationService } from './verification.service.js';

const EMAIL_TOKEN_TTL_MINUTES = 24 * 60;
const RESET_TOKEN_TTL_MINUTES = 30;
const PHONE_OTP_TTL_MINUTES = 5;
const INVALID_TOKEN = 'This link is invalid or has expired';

@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger(AccountSecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly verification: VerificationService,
    private readonly sessions: SessionStateService,
    private readonly captcha: CaptchaVerifier,
    private readonly breached: BreachedPasswordChecker,
    private readonly notifications: NotificationPort,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------------- email verification

  async verifyEmail(token: string, ctx: RequestContext): Promise<void> {
    const row = await this.verification.consumeToken(
      token,
      'EMAIL_VERIFICATION',
    );
    if (!row) throw apiError(400, ErrorCode.BadRequest, INVALID_TOKEN);
    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { id: true, emailNormalized: true, status: true },
    });
    // A token issued for an address the account no longer uses must not verify the new one.
    if (!user || user.emailNormalized !== row.target)
      throw apiError(400, ErrorCode.BadRequest, INVALID_TOKEN);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        ...(user.status === 'PENDING_VERIFICATION' ? { status: 'ACTIVE' } : {}),
      },
    });
    await this.audit.record({
      action: AuditAction.EmailVerified,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
  }

  /** Uniform response; the work happens in the background so timing does not reveal whether the account exists. */
  resendVerification(rawEmail: string): void {
    void this.runDetached('resend-verification', async () => {
      const user = await this.prisma.user.findUnique({
        where: { emailNormalized: normalizeEmail(rawEmail) },
        include: { customer: { select: { firstName: true, lastName: true } } },
      });
      if (user?.status !== 'PENDING_VERIFICATION') return;
      const token = await this.verification.issueToken(
        user.id,
        'EMAIL_VERIFICATION',
        user.emailNormalized,
        EMAIL_TOKEN_TTL_MINUTES,
      );
      await this.notifications.send({
        type: 'EMAIL_VERIFICATION',
        email: user.emailNormalized,
        name: displayName(user.customer),
        token,
      });
    });
  }

  // ------------------------------------------------------------------------------ phone OTP

  async sendPhoneOtp(principal: AuthPrincipal): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: { phoneE164: true, phoneVerifiedAt: true },
    });
    if (!user?.phoneE164)
      throw apiError(
        400,
        ErrorCode.BadRequest,
        'No phone number on this account',
      );
    if (user.phoneVerifiedAt)
      throw new ConflictException({
        message: 'Phone number is already verified',
        code: ErrorCode.Conflict,
      });
    const code = await this.verification.issueOtp(
      principal.userId,
      'PHONE_OTP',
      user.phoneE164,
      PHONE_OTP_TTL_MINUTES,
    );
    await this.notifications.send({
      type: 'PHONE_OTP',
      phone: user.phoneE164,
      code,
    });
  }

  async verifyPhone(
    principal: AuthPrincipal,
    code: string,
    ctx: RequestContext,
  ): Promise<void> {
    const hit = await this.verification.verifyOtp(
      principal.userId,
      'PHONE_OTP',
      code,
    );
    if (!hit)
      throw apiError(
        400,
        ErrorCode.BadRequest,
        'The code is incorrect or has expired',
      );
    try {
      await this.prisma.user.update({
        where: { id: principal.userId },
        data: { phoneE164: hit.target, phoneVerifiedAt: new Date() },
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({
          message: 'This phone number is already verified on another account',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
    await this.audit.record({
      action: AuditAction.PhoneVerified,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
    });
  }

  // ------------------------------------------------------------------------- password lifecycle

  /** Uniform response and detached work: no enumeration by body, status or timing. */
  forgotPassword(rawEmail: string, ctx: RequestContext): void {
    void this.runDetached('forgot-password', async () => {
      const user = await this.prisma.user.findUnique({
        where: { emailNormalized: normalizeEmail(rawEmail) },
        include: { customer: { select: { firstName: true, lastName: true } } },
      });
      if (user?.status !== 'ACTIVE') return;
      const token = await this.verification.issueToken(
        user.id,
        'PASSWORD_RESET',
        user.emailNormalized,
        RESET_TOKEN_TTL_MINUTES,
      );
      await this.audit.record({
        action: AuditAction.PasswordResetRequested,
        outcome: 'SUCCESS',
        actorId: user.id,
        ...ctx,
      });
      await this.notifications.send({
        type: 'PASSWORD_RESET',
        email: user.emailNormalized,
        name: displayName(user.customer),
        token,
      });
    });
  }

  async verifyCaptcha(
    token: string | undefined,
    ip: string | null,
  ): Promise<void> {
    if (!(await this.captcha.verify(token, ip)))
      throw apiError(400, 'CAPTCHA_FAILED', 'Captcha verification failed');
  }

  async resetPassword(
    token: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    const peek = await this.verification.peekToken(token, 'PASSWORD_RESET');
    if (!peek) throw apiError(400, ErrorCode.BadRequest, INVALID_TOKEN);
    const user = await this.prisma.user.findUnique({
      where: { id: peek.userId },
      include: { customer: { select: { firstName: true, lastName: true } } },
    });
    if (user?.emailNormalized !== peek.target)
      throw apiError(400, ErrorCode.BadRequest, INVALID_TOKEN);

    // Validate the new password BEFORE consuming the token, so a weak choice does not burn the user's link.
    await this.assertAcceptablePassword(newPassword, {
      email: user.emailNormalized,
      ...user.customer,
    });
    const passwordHash = await this.passwords.hash(newPassword);

    const consumed = await this.verification.consumeToken(
      token,
      'PASSWORD_RESET',
    );
    if (consumed?.id !== peek.id)
      throw apiError(400, ErrorCode.BadRequest, INVALID_TOKEN);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null, // completing a reset is also the lockout recovery path
        // Controlling the mailbox proves the address, so a pending account becomes active.
        ...(user.status === 'PENDING_VERIFICATION'
          ? { status: 'ACTIVE', emailVerifiedAt: new Date() }
          : {}),
      },
    });
    await this.sessions.revokeAllForUser(user.id, 'PASSWORD_RESET');
    await this.audit.record({
      action: AuditAction.PasswordResetCompleted,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
    await this.notifications
      .send({
        type: 'PASSWORD_CHANGED',
        email: user.email,
        name: displayName(user.customer),
      })
      .catch((e) => this.logger.error({ err: e }, 'Notice failed'));
  }

  async changePassword(
    principal: AuthPrincipal,
    current: string,
    next: string,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      include: { customer: { select: { firstName: true, lastName: true } } },
    });
    if (!user) throw invalidCredentials();
    if (!(await this.passwords.verify(user.passwordHash, current))) {
      await this.audit.record({
        action: AuditAction.LoginFailure,
        outcome: 'FAILURE',
        actorId: user.id,
        ...ctx,
        metadata: { reason: 'change_password_bad_current' },
      });
      throw invalidCredentials();
    }
    await this.assertAcceptablePassword(next, {
      email: user.emailNormalized,
      ...user.customer,
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(next),
        passwordChangedAt: new Date(),
      },
    });
    // Sensitive credential change: every OTHER device is signed out.
    await this.sessions.revokeAllForUser(
      user.id,
      'PASSWORD_CHANGED',
      principal.sessionId,
    );
    await this.audit.record({
      action: AuditAction.PasswordChanged,
      outcome: 'SUCCESS',
      actorId: user.id,
      ...ctx,
    });
    await this.notifications
      .send({
        type: 'PASSWORD_CHANGED',
        email: user.email,
        name: displayName(user.customer),
      })
      .catch((e) => this.logger.error({ err: e }, 'Notice failed'));
  }

  private async assertAcceptablePassword(
    password: string,
    ctx: { email: string; firstName?: string; lastName?: string },
  ): Promise<void> {
    const violations = passwordViolations(password, ctx);
    if (violations.length > 0) {
      throw apiError(
        400,
        ErrorCode.ValidationFailed,
        'Password does not meet the requirements',
        {
          issues: violations.map((message) => ({
            path: ['newPassword'],
            message,
          })),
        },
      );
    }
    if (await this.breached.isBreached(password)) {
      throw apiError(
        400,
        ErrorCode.ValidationFailed,
        'This password has appeared in a data breach. Please choose another.',
        {
          issues: [
            {
              path: ['newPassword'],
              message: 'has appeared in a known data breach',
            },
          ],
        },
      );
    }
  }

  private runDetached(label: string, work: () => Promise<void>): Promise<void> {
    return work().catch((err) =>
      this.logger.error({ err, label }, 'Detached task failed'),
    );
  }
}
