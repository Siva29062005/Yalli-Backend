import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Res } from '@nestjs/common';
import type { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
  Public,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { requestContext } from '../audit/audit.service.js';
import { AuthCookies } from './auth-cookies.service.js';
import {
  mfaCodeSchema,
  mfaConfirmSchema,
  mfaDisableSchema,
  mfaEnrollSchema,
  mfaVerifySchema,
} from './dto/auth.schemas.js';
import { AuthService } from './services/auth.service.js';
import { MfaService } from './services/mfa.service.js';

const TEN_MINUTES = 600;

@ApiTags('auth-mfa')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly cookies: AuthCookies,
  ) {}

  @Authenticated()
  @Post('enroll')
  @HttpCode(200)
  @ResponseMessage(
    'Scan the QR code / enter the secret in your authenticator app, then confirm with a code',
  )
  @RateLimit({
    name: 'mfa-enroll',
    limit: 10,
    windowSeconds: TEN_MINUTES,
    key: 'principal',
  })
  enroll(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: mfaEnrollSchema }) dto: z.infer<typeof mfaEnrollSchema>,
    @Req() req: Request,
  ) {
    return this.mfa.enroll(principal, dto.password, requestContext(req));
  }

  @Authenticated()
  @Post('confirm')
  @HttpCode(200)
  @ResponseMessage(
    'Multi-factor authentication enabled. Store these recovery codes safely: they are shown only once.',
  )
  @RateLimit({
    name: 'mfa-confirm',
    limit: 10,
    windowSeconds: TEN_MINUTES,
    key: 'principal',
  })
  async confirm(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: mfaConfirmSchema }) dto: z.infer<typeof mfaConfirmSchema>,
    @Req() req: Request,
  ) {
    return {
      recoveryCodes: await this.mfa.confirm(
        principal,
        dto.code,
        requestContext(req),
      ),
    };
  }

  /** Second step of login for accounts with MFA. Authenticated by the single-use challenge token, not a bearer token. */
  @Public()
  @Post('verify')
  @HttpCode(200)
  @ResponseMessage('Signed in')
  @RateLimit({
    name: 'mfa-verify-ip',
    limit: 20,
    windowSeconds: TEN_MINUTES,
    key: 'ip',
  })
  async verify(
    @Body({ schema: mfaVerifySchema }) dto: z.infer<typeof mfaVerifySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = requestContext(req);
    const challenge = await this.auth.resolveMfaChallenge(dto.mfaToken);
    const ok = await this.mfa.verifySecondFactor(challenge.userId, dto, ctx);
    if (!ok)
      throw new UnauthorizedException({
        message: 'The code is incorrect or expired',
        code: ErrorCode.Unauthorized,
      });
    await challenge.consume(); // a challenge can be redeemed exactly once
    const t = await this.auth.completeMfaLogin(challenge.userId, ctx);
    const base = {
      mfaRequired: false,
      tokenType: 'Bearer',
      accessToken: t.accessToken,
      expiresIn: t.expiresIn,
    };
    return this.cookies.isCookieMode(req)
      ? {
          ...base,
          csrfToken: this.cookies.issue(
            res,
            t.refreshToken,
            t.refreshExpiresAt,
          ),
        }
      : { ...base, refreshToken: t.refreshToken };
  }

  /** Re-authenticate with a fresh code to unlock sensitive operations; returns a new access token. */
  @Authenticated()
  @Post('step-up')
  @HttpCode(200)
  @ResponseMessage('Verified')
  @RateLimit({
    name: 'mfa-stepup',
    limit: 10,
    windowSeconds: TEN_MINUTES,
    key: 'principal',
  })
  stepUp(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: mfaCodeSchema }) dto: z.infer<typeof mfaCodeSchema>,
    @Req() req: Request,
  ) {
    return this.mfa.stepUp(principal, dto.code, requestContext(req));
  }

  @Authenticated()
  @Post('disable')
  @HttpCode(200)
  @ResponseMessage('Multi-factor authentication disabled')
  @RateLimit({
    name: 'mfa-disable',
    limit: 5,
    windowSeconds: TEN_MINUTES,
    key: 'principal',
  })
  async disable(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: mfaDisableSchema }) dto: z.infer<typeof mfaDisableSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.mfa.disable(principal, dto, requestContext(req));
    return null;
  }

  @Authenticated()
  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  @ResponseMessage(
    'New recovery codes generated; previous codes no longer work',
  )
  @RateLimit({
    name: 'mfa-recovery-regen',
    limit: 5,
    windowSeconds: TEN_MINUTES,
    key: 'principal',
  })
  async regenerate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body({ schema: mfaCodeSchema }) dto: z.infer<typeof mfaCodeSchema>,
    @Req() req: Request,
  ) {
    return {
      recoveryCodes: await this.mfa.regenerateRecoveryCodes(
        principal,
        dto.code,
        requestContext(req),
      ),
    };
  }
}
