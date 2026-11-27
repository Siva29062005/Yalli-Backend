import {
  Controller,
  Get,
  HttpCode,
  Param,
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
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { paginationSchema } from '../../common/http/pagination.js';
import { Permission } from '../access/permissions.js';
import { requestContext } from '../audit/audit.service.js';
import { ContactService } from './contact.service.js';

const listSchema = paginationSchema
  .extend({ status: z.enum(['NEW', 'HANDLED']).optional() })
  .strict();

/** Contact-form messages for support (customers.read): read them, mark them handled once answered. */
@ApiTags('admin-contact')
@Controller('admin/contact-messages')
@RequireStepUp(1800)
@RequirePermissions(Permission.CustomersRead)
@RateLimit({
  name: 'admin-contact',
  limit: 120,
  windowSeconds: 60,
  key: 'principal',
})
export class ContactAdminController {
  constructor(private readonly contact: ContactService) {}

  @Get()
  list(@Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.contact.adminList(q);
  }

  @Post(':id/handled')
  @HttpCode(200)
  async handled(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: z.uuid() }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.contact.markHandled(a.userId, id, requestContext(req));
    return null;
  }
}
