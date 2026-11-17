import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/access.decorators.js';
import { SkipEnvelope } from '../../common/decorators/response.decorators.js';
import { AccessTokenService } from './jwt/access-token.service.js';

/** Public verification keys (RFC 7517) so other services can verify access tokens without sharing a secret. */
@ApiExcludeController()
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class JwksController {
  constructor(private readonly tokens: AccessTokenService) {}

  @Public()
  @SkipEnvelope()
  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  jwks() {
    return this.tokens.jwks();
  }
}
