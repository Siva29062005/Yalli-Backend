import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
  PERMISSIONS_KEY,
  STEP_UP_KEY,
} from '../../../common/decorators/access.decorators.js';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';
import { AuditAction } from '../../audit/audit-actions.js';
import { AuditService, requestContext } from '../../audit/audit.service.js';

/**
 * Global authorization, DENY BY DEFAULT: a route that declares no policy is refused (and the boot-time
 * AccessPolicyAuditor prevents such a route from shipping in the first place).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets))
      return true;
    // Guest-or-user routes: any identity present was already fully verified by JwtAuthGuard.
    if (this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets))
      return true;

    const req = context.switchToHttp().getRequest<Request>();
    const principal = req.auth;
    if (!principal) throw new UnauthorizedException('Authentication required');

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(
      IS_AUTHENTICATED_KEY,
      targets,
    );

    if (!required && !authenticatedOnly) {
      this.logger.error(
        `Route ${req.method} ${req.path} declares no access policy; denying`,
      );
      return this.deny(req, 'no-policy');
    }
    if (required && !required.every((p) => principal.permissions.has(p)))
      return this.deny(req, 'missing-permission', required);

    const stepUp = this.reflector.getAllAndOverride<
      { maxAgeSeconds: number } | undefined
    >(STEP_UP_KEY, targets);
    if (stepUp) {
      const fresh =
        Math.floor(Date.now() / 1000) - principal.authTime <=
        stepUp.maxAgeSeconds;
      if (!principal.amr.includes('otp') || !fresh) {
        throw new ForbiddenException({
          message: 'Recent multi-factor verification is required',
          code: ErrorCode.StepUpRequired,
        });
      }
    }
    return true;
  }

  private async deny(
    req: Request,
    reason: string,
    required?: string[],
  ): Promise<never> {
    await this.audit.record({
      action: AuditAction.AccessDenied,
      outcome: 'DENIED',
      actorId: req.auth?.userId,
      ...requestContext(req),
      metadata: {
        reason,
        method: req.method,
        path: req.route?.path ?? req.path,
        required,
      },
    });
    throw new ForbiddenException(
      'You do not have permission to perform this action',
    );
  }
}
