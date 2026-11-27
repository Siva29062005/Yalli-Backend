import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
} from '../../../common/decorators/access.decorators.js';
import { AuthorizationService } from '../../access/authorization.service.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import { SessionStateService } from '../services/session-state.service.js';

import { ErrorCode } from '../../../common/exceptions/error-codes.js';

const UNAUTHENTICATED = {
  message: 'Authentication required',
  code: ErrorCode.AccessTokenInvalid,
};

/**
 * Global authentication. Routes are private unless marked @Public().
 * The principal is rebuilt on every request from server-side state: a token alone is never enough.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStateService,
    private readonly authz: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets))
      return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    // @OptionalAuth: no credential at all => guest. A credential that IS present must be valid (checked below).
    if (
      header === undefined &&
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets)
    )
      return true;
    const match =
      typeof header === 'string'
        ? /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(header)
        : null;
    if (!match?.[1]) throw new UnauthorizedException(UNAUTHENTICATED);

    let claims;
    try {
      claims = await this.tokens.verify(match[1]);
    } catch {
      throw new UnauthorizedException(UNAUTHENTICATED);
    }
    if (!(await this.sessions.isActive(claims.sessionId, claims.userId)))
      throw new UnauthorizedException(UNAUTHENTICATED);

    const access = await this.authz.loadAccess(claims.userId);
    if (access?.status !== 'ACTIVE')
      throw new UnauthorizedException(UNAUTHENTICATED);

    req.auth = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      amr: claims.amr,
      authTime: claims.authTime,
      roles: access.roles.map((r) => ({ name: r.name, rank: r.rank })),
      permissions: new Set(access.permissions),
      maxRank: access.maxRank,
    };
    return true;
  }
}
