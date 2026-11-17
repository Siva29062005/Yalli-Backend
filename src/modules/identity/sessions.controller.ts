import { Controller, Delete, Get, HttpCode, Param, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
} from '../../common/decorators/access.decorators.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { requestContext } from '../audit/audit.service.js';
import { sessionIdParamSchema } from './dto/auth.schemas.js';
import { AuthService } from './services/auth.service.js';

/** A user's own device sessions. Every query is scoped to the caller: other users' sessions are simply not found. */
@ApiTags('auth-sessions')
@Controller('auth/sessions')
export class SessionsController {
  constructor(private readonly auth: AuthService) {}

  @Authenticated()
  @Get()
  list(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.auth.listSessions(principal);
  }

  @Authenticated()
  @Delete(':id')
  @HttpCode(200)
  @ResponseMessage('Session revoked')
  async revoke(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', { schema: sessionIdParamSchema }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.auth.revokeOwnSession(principal, id, requestContext(req));
    return null;
  }
}
