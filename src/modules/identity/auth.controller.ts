import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  Authenticated,
  CurrentPrincipal,
  Public,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { requestContext } from '../audit/audit.service.js';
import { AuthCookies } from './auth-cookies.service.js';
import {
  changePasswordSchema,
  emailOnlySchema,
  loginSchema,
  phoneVerifySchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type LoginDto,
  type RegisterDto,
} from './dto/auth.schemas.js';
import { CsrfGuard } from './guards/csrf.guard.js';
import { AccountSecurityService } from './services/account-security.service.js';
import { AuthService, type SessionTokens } from './services/auth.service.js';
import { normalizeEmail } from './services/identity-utils.js';
import { RegistrationService } from './services/registration.service.js';
import type { z } from 'zod';

const emailKey = (req: Request): string | undefined => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.length <= 254
    ? normalizeEmail(email)
    : undefined;
};

const MINUTE = 60;
const HOUR = 3_600;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly auth: AuthService,
    private readonly account: AccountSecurityService,
    private readonly cookies: AuthCookies,
  ) {}

  /** Sends tokens in the body (API/mobile) or, with `X-Auth-Mode: cookie`, the refresh token as an HttpOnly cookie. */
  private tokenResponse(
    req: Request,
    res: Response,
    t: SessionTokens,
    keepCsrf?: string,
  ) {
    const base = {
      mfaRequired: false,
      tokenType: 'Bearer',
      accessToken: t.accessToken,
      expiresIn: t.expiresIn,
    };
    if (this.cookies.isCookieMode(req))
      return {
        ...base,
        csrfToken: this.cookies.issue(
          res,
          t.refreshToken,
          t.refreshExpiresAt,
          t.persistent,
          keepCsrf,
        ),
      };
    return { ...base, refreshToken: t.refreshToken };
  }

  @Public()
  @Post('register')
  @HttpCode(202)
  @ResponseMessage(
    'If the details are valid, a verification email is on its way',
  )
  @RateLimit(
    { name: 'register-ip', limit: 10, windowSeconds: HOUR, key: 'ip' },
    { name: 'register-email', limit: 5, windowSeconds: HOUR, key: emailKey },
  )
  async register(
    @Body({ schema: registerSchema }) dto: RegisterDto,
    @Req() req: Request,
  ): Promise<null> {
    await this.registration.register(dto, requestContext(req));
    return null;
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @ResponseMessage('Email verified')
  @RateLimit({
    name: 'verify-email-ip',
    limit: 20,
    windowSeconds: 10 * MINUTE,
    key: 'ip',
  })
  async verifyEmail(
    @Body({ schema: verifyEmailSchema }) dto: z.infer<typeof verifyEmailSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.verifyEmail(dto.token, requestContext(req));
    return null;
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(202)
  @ResponseMessage(
    'If that account needs verification, a new email is on its way',
  )
  @RateLimit(
    { name: 'resend-ip', limit: 10, windowSeconds: HOUR, key: 'ip' },
    { name: 'resend-email', limit: 3, windowSeconds: HOUR, key: emailKey },
  )
  resendVerification(
    @Body({ schema: emailOnlySchema }) dto: z.infer<typeof emailOnlySchema>,
  ): null {
    this.account.resendVerification(dto.email);
    return null;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ResponseMessage('Signed in')
  @RateLimit(
    { name: 'login-ip', limit: 30, windowSeconds: 10 * MINUTE, key: 'ip' },
    // Per-account limit throttles credential stuffing / guessing distributed across many IPs.
    {
      name: 'login-email',
      limit: 10,
      windowSeconds: 10 * MINUTE,
      key: emailKey,
    },
  )
  async login(
    @Body({ schema: loginSchema }) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(
      dto,
      requestContext(req),
      this.cookies.isCookieMode(req),
    );
    if (result.kind === 'mfa')
      return {
        mfaRequired: true,
        mfaToken: result.mfaToken,
        mfaExpiresIn: result.expiresIn,
      };
    return this.tokenResponse(req, res, result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ResponseMessage('Session refreshed')
  @RateLimit({
    name: 'refresh-ip',
    limit: 60,
    windowSeconds: MINUTE,
    key: 'ip',
  })
  async refresh(
    @Body({ schema: refreshSchema }) dto: z.infer<typeof refreshSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = dto.refreshToken ?? this.cookies.readRefresh(req);
    if (!raw)
      throw new UnauthorizedException({
        message: 'Session expired. Please sign in again.',
        code: ErrorCode.Unauthorized,
      });
    try {
      // The browser path ONLY: the refresh token came from the HttpOnly cookie (CsrfGuard then checked the CSRF header
      // against the CSRF cookie). A token sent in the body (API / mobile client) gets strict reuse detection and a new
      // CSRF token, whatever X-Auth-Mode says.
      const fromCookie =
        this.cookies.isCookieMode(req) && dto.refreshToken === undefined;
      const r = await this.auth.refresh(raw, requestContext(req), {
        browserGrace: fromCookie,
      });
      const csrf = fromCookie ? this.cookies.readCsrf(req) : undefined;
      if ('kind' in r)
        return {
          mfaRequired: false,
          tokenType: 'Bearer',
          accessToken: r.accessToken,
          expiresIn: r.expiresIn,
          csrfToken: csrf,
        };
      return this.tokenResponse(req, res, r, csrf);
    } catch (err) {
      if (this.cookies.isCookieMode(req)) this.cookies.clear(res); // a dead token should not be retried forever
      throw err;
    }
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(200)
  @ResponseMessage('Signed out')
  async logout(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    await this.auth.logout(principal, requestContext(req));
    this.cookies.clear(res);
    return null;
  }

  @Authenticated()
  @Post('logout-all')
  @HttpCode(200)
  @ResponseMessage('Signed out of all devices')
  async logoutAll(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const revoked = await this.auth.logoutAll(principal, requestContext(req));
    this.cookies.clear(res);
    return { sessionsRevoked: revoked };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @ResponseMessage(
    'If an account exists for that email, a reset link is on its way',
  )
  @RateLimit(
    { name: 'forgot-ip', limit: 10, windowSeconds: HOUR, key: 'ip' },
    { name: 'forgot-email', limit: 3, windowSeconds: HOUR, key: emailKey },
  )
  async forgotPassword(
    @Body({ schema: emailOnlySchema }) dto: z.infer<typeof emailOnlySchema>,
    @Req() req: Request,
  ): Promise<null> {
    const ctx = requestContext(req);
    await this.account.verifyCaptcha(dto.captchaToken, ctx.ip);
    this.account.forgotPassword(dto.email, ctx);
    return null;
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @ResponseMessage('Password updated. Please sign in.')
  @RateLimit({ name: 'reset-ip', limit: 10, windowSeconds: HOUR, key: 'ip' })
  async resetPassword(
    @Body({ schema: resetPasswordSchema })
    dto: z.infer<typeof resetPasswordSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.resetPassword(
      dto.token,
      dto.newPassword,
      requestContext(req),
    );
    return null;
  }

  @Authenticated()
  @Post('change-password')
  @HttpCode(200)
  @ResponseMessage('Password changed. Other devices were signed out.')
  @RateLimit({
    name: 'change-password',
    limit: 10,
    windowSeconds: HOUR,
    key: 'principal',
  })
  async changePassword(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: changePasswordSchema })
    dto: z.infer<typeof changePasswordSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.changePassword(
      principal,
      dto.currentPassword,
      dto.newPassword,
      requestContext(req),
    );
    return null;
  }

  @Authenticated()
  @Post('phone/send-otp')
  @HttpCode(202)
  @ResponseMessage('A verification code has been sent')
  @RateLimit({
    name: 'phone-otp-send',
    limit: 3,
    windowSeconds: HOUR,
    key: 'principal',
  })
  async sendPhoneOtp(
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<null> {
    await this.account.sendPhoneOtp(principal);
    return null;
  }

  @Authenticated()
  @Post('phone/verify')
  @HttpCode(200)
  @ResponseMessage('Phone number verified')
  @RateLimit({
    name: 'phone-otp-verify',
    limit: 10,
    windowSeconds: HOUR,
    key: 'principal',
  })
  async verifyPhone(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: phoneVerifySchema }) dto: z.infer<typeof phoneVerifySchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.verifyPhone(principal, dto.code, requestContext(req));
    return null;
  }
}
