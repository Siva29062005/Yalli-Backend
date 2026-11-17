import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { CSRF_HEADER } from '../../../common/constants/auth.js';
import type { Env } from '../../../config/env.js';
import { AuthCookies } from '../auth-cookies.service.js';
import { safeEqual } from '../crypto/token-utils.js';

/**
 * CSRF protection for COOKIE-authenticated, state-changing requests (refresh, in cookie mode).
 * Applies only when the credential arrives via the cookie; requests that carry the token explicitly in the body
 * or an Authorization header cannot be forged cross-site (browsers do not attach those automatically).
 * Defence in depth: the Origin header, when present, must be on the CORS allow-list.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins: readonly string[];

  constructor(
    config: ConfigService<Env, true>,
    private readonly cookies: AuthCookies,
  ) {
    this.allowedOrigins = config.get('CORS_ALLOWED_ORIGINS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const bodyToken = (req.body as { refreshToken?: unknown } | undefined)
      ?.refreshToken;
    if (typeof bodyToken === 'string' || !this.cookies.readRefresh(req))
      return true;

    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.allowedOrigins.includes(origin))
      throw new ForbiddenException('Cross-site request blocked');

    const header = req.headers[CSRF_HEADER];
    const cookie = this.cookies.readCsrf(req);
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie))
      throw new ForbiddenException('Cross-site request blocked');
    return true;
  }
}
