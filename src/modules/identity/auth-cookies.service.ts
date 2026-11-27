import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';
import {
  AUTH_MODE_HEADER,
  REFRESH_COOKIE_PATH,
  cookieNames,
} from '../../common/constants/auth.js';
import type { Env } from '../../config/env.js';
import { generateToken } from './crypto/token-utils.js';

/**
 * Cookie-mode delivery for browsers (opt-in via `X-Auth-Mode: cookie`).
 * - refresh token: HttpOnly, Secure, SameSite=Strict, path-scoped; JavaScript can never read it.
 * - CSRF token: double-submit. The client gets it in the response body and echoes it in `X-CSRF-Token`;
 *   the server compares it with this cookie. A cross-site attacker can make the browser SEND the cookies but can
 *   neither read the body nor set the header.
 */
@Injectable()
export class AuthCookies {
  private readonly secure: boolean;
  readonly names: { refresh: string; csrf: string };

  constructor(config: ConfigService<Env, true>) {
    this.secure = config.get('COOKIE_SECURE', { infer: true });
    this.names = cookieNames(this.secure);
  }

  isCookieMode(req: Request): boolean {
    return req.headers[AUTH_MODE_HEADER] === 'cookie';
  }

  readRefresh(req: Request): string | undefined {
    return this.parse(req)[this.names.refresh];
  }

  readCsrf(req: Request): string | undefined {
    return this.parse(req)[this.names.csrf];
  }

  /**
   * Sets both cookies and returns the CSRF token for the response body. Not persistent (no "keep me signed in", and
   * always for staff): no Expires, so the browser drops them when it closes; the server-side expiry still applies.
   */
  issue(
    res: Response,
    refreshToken: string,
    expiresAt: Date,
    persistent: boolean,
    /** Keep the session's CSRF token on refresh: every tab of the browser holds a copy, and rotating it would sign
     *  the other tabs out at their next refresh. A new token is made at sign-in. */
    keepCsrf?: string,
  ): string {
    const csrf =
      keepCsrf && /^[A-Za-z0-9_-]{16,128}$/.test(keepCsrf)
        ? keepCsrf
        : generateToken(24);
    const common = {
      secure: this.secure,
      sameSite: 'strict' as const,
      ...(persistent ? { expires: expiresAt } : {}),
    };
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: this.names.refresh,
        value: refreshToken,
        httpOnly: true,
        path: REFRESH_COOKIE_PATH,
        ...common,
      }),
    );
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: this.names.csrf,
        value: csrf,
        httpOnly: false,
        path: REFRESH_COOKIE_PATH,
        ...common,
      }),
    );
    return csrf;
  }

  clear(res: Response): void {
    const expired = {
      secure: this.secure,
      sameSite: 'strict' as const,
      path: REFRESH_COOKIE_PATH,
      expires: new Date(0),
      maxAge: 0,
    };
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: this.names.refresh,
        value: '',
        httpOnly: true,
        ...expired,
      }),
    );
    res.append(
      'Set-Cookie',
      stringifySetCookie({ name: this.names.csrf, value: '', ...expired }),
    );
  }

  private parse(req: Request): Record<string, string | undefined> {
    const header = req.headers.cookie;
    return typeof header === 'string' ? parseCookie(header) : {};
  }
}
