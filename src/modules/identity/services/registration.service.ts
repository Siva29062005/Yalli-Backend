import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';
import { RoleName } from '../../access/permissions.js';
import { AuditAction } from '../../audit/audit-actions.js';
import {
  AuditService,
  type RequestContext,
} from '../../audit/audit.service.js';
import { passwordViolations } from '../crypto/password-policy.js';
import { PasswordService } from '../crypto/password.service.js';
import type { RegisterDto } from '../dto/auth.schemas.js';
import {
  BreachedPasswordChecker,
  CaptchaVerifier,
  NotificationPort,
} from '../ports/ports.js';
import {
  apiError,
  isUniqueViolation,
  normalizeEmail,
} from './identity-utils.js';
import { VerificationService } from './verification.service.js';

const EMAIL_TOKEN_TTL_MINUTES = 24 * 60;
const PRIVACY_POLICY_VERSION = 'v1';

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly verification: VerificationService,
    private readonly captcha: CaptchaVerifier,
    private readonly breached: BreachedPasswordChecker,
    private readonly notifications: NotificationPort,
    private readonly audit: AuditService,
  ) {}

  /**
   * Always resolves the same way for a well-formed request, whether or not the email is already registered
   * (no account enumeration). An existing owner gets an "already registered" email instead of a verification link.
   */
  async register(dto: RegisterDto, ctx: RequestContext): Promise<void> {
    if (!(await this.captcha.verify(dto.captchaToken, ctx.ip, 'register'))) {
      throw apiError(400, 'CAPTCHA_FAILED', 'Captcha verification failed');
    }

    const email = normalizeEmail(dto.email);
    const violations = passwordViolations(dto.password, {
      email,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    if (violations.length > 0) {
      throw apiError(
        400,
        ErrorCode.ValidationFailed,
        'Password does not meet the requirements',
        {
          issues: violations.map((message) => ({
            path: ['password'],
            message,
          })),
        },
      );
    }
    if (await this.breached.isBreached(dto.password)) {
      throw apiError(
        400,
        ErrorCode.ValidationFailed,
        'This password has appeared in a data breach. Please choose another.',
        {
          issues: [
            {
              path: ['password'],
              message: 'has appeared in a known data breach',
            },
          ],
        },
      );
    }

    // Hash BEFORE looking the email up so the expensive step costs the same in both outcomes.
    const passwordHash = await this.passwords.hash(dto.password);
    const name = `${dto.firstName} ${dto.lastName}`.trim();

    const existing = await this.prisma.user.findUnique({
      where: { emailNormalized: email },
      select: { id: true, status: true },
    });
    if (existing) return this.handleDuplicate(existing, email, name, ctx);

    const customerRole = await this.prisma.role.findUnique({
      where: { name: RoleName.Customer },
      select: { id: true },
    });
    if (!customerRole)
      throw new Error('CUSTOMER role is missing: run the seed command');

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email.trim(),
            emailNormalized: email,
            phoneE164: dto.phone,
            passwordHash,
            customer: {
              create: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                newsletterSubscribed: dto.newsletter,
              },
            },
            consents: {
              create: {
                type: 'PRIVACY_POLICY',
                version: PRIVACY_POLICY_VERSION,
                ip: ctx.ip,
              },
            },
            roles: { create: { roleId: customerRole.id } },
          },
          select: { id: true },
        });
        return user.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a race with a concurrent registration of the same email: behave like the duplicate path.
        const raced = await this.prisma.user.findUnique({
          where: { emailNormalized: email },
          select: { id: true, status: true },
        });
        if (raced) return this.handleDuplicate(raced, email, name, ctx);
      }
      throw err;
    }

    const token = await this.verification.issueToken(
      userId,
      'EMAIL_VERIFICATION',
      email,
      EMAIL_TOKEN_TTL_MINUTES,
    );
    await this.audit.record({
      action: AuditAction.UserRegistered,
      outcome: 'SUCCESS',
      actorId: userId,
      ...ctx,
      resourceType: 'user',
      resourceId: userId,
    });
    await this.notifications
      .send({ type: 'EMAIL_VERIFICATION', email, name, token })
      .catch((err) => this.logger.error({ err }, 'Verification email failed'));
  }

  private async handleDuplicate(
    existing: { id: string; status: string },
    email: string,
    name: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      action: AuditAction.RegisterDuplicateAttempt,
      outcome: 'DENIED',
      actorId: existing.id,
      ...ctx,
      resourceType: 'user',
      resourceId: existing.id,
    });
    if (existing.status !== 'DELETED') {
      await this.notifications
        .send({ type: 'ACCOUNT_ALREADY_EXISTS', email, name })
        .catch((err) => this.logger.error({ err }, 'Notification failed'));
    }
  }
}
