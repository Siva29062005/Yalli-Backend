import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
  RequireStepUp,
} from '../../common/decorators/access.decorators.js';
import { paginationSchema } from '../../common/http/pagination.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { Permission, ROLE_DEFINITIONS } from '../access/permissions.js';
import { requestContext } from '../audit/audit.service.js';
import { AdminAccessService } from './admin-access.service.js';

const roleNames = Object.keys(ROLE_DEFINITIONS) as [string, ...string[]];
const userIdParam = z.uuid();
const roleParam = z.enum(roleNames);
const assignSchema = z.object({ role: z.enum(roleNames) }).strict();
const listUsersSchema = paginationSchema
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    role: roleParam.optional(),
    status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED']).optional(),
  })
  .strict();
const statusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .strict();

/**
 * Privileged access management. Every route needs (a) a specific permission, (b) a recent MFA step-up, and its
 * mutations are additionally subject to the rank rules in role-policy.ts and are audited.
 */
@ApiTags('admin-access')
@Controller('admin')
@RequireStepUp(1800)
@RateLimit({
  name: 'admin-ops',
  limit: 60,
  windowSeconds: 60,
  key: 'principal',
})
export class AdminAccessController {
  constructor(private readonly access: AdminAccessService) {}

  @Get('roles')
  @RequirePermissions(Permission.UsersManage)
  roles() {
    return this.access.listRoles();
  }

  @Get('users')
  @RequirePermissions(Permission.UsersManage)
  users(
    @Query({ schema: listUsersSchema }) q: z.infer<typeof listUsersSchema>,
  ) {
    return this.access.listUsers(q);
  }

  @Get('permissions')
  @RequirePermissions(Permission.PermissionsManage)
  permissions() {
    return this.access.listPermissions();
  }

  @Post('users/:userId/roles')
  @HttpCode(200)
  @RequireStepUp(600)
  @RequirePermissions(Permission.UsersManage)
  @ResponseMessage('Role assigned')
  async assign(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('userId', { schema: userIdParam }) userId: string,
    @Body({ schema: assignSchema }) dto: z.infer<typeof assignSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.access.assignRole(actor, userId, dto.role, requestContext(req));
    return null;
  }

  @Delete('users/:userId/roles/:role')
  @HttpCode(200)
  @RequireStepUp(600)
  @RequirePermissions(Permission.UsersManage)
  @ResponseMessage('Role revoked')
  async revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('userId', { schema: userIdParam }) userId: string,
    @Param('role', { schema: roleParam }) role: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.access.revokeRole(actor, userId, role, requestContext(req));
    return null;
  }

  @Patch('users/:userId/status')
  @HttpCode(200)
  @RequireStepUp(600)
  @RequirePermissions(Permission.CustomersSuspend)
  @ResponseMessage('Account status updated')
  async status(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('userId', { schema: userIdParam }) userId: string,
    @Body({ schema: statusSchema }) dto: z.infer<typeof statusSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.access.setStatus(
      actor,
      userId,
      dto.status,
      dto.reason,
      requestContext(req),
    );
    return null;
  }
}
