import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
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
import { Permission } from '../access/permissions.js';
import { requestContext } from '../audit/audit.service.js';
import { emailSchema, phoneSchema } from '../identity/dto/auth.schemas.js';
import { CustomerLookupService } from './customer-lookup.service.js';

/** Exactly one exact identifier: an email, a phone number or an order number. */
const searchSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    order: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{4,20}$/)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.email, v.phone, v.order].filter((x) => x !== undefined).length === 1,
    { message: 'Search by exactly one of email, phone or order' },
  );

@ApiTags('admin-customers')
@Controller('admin/customers')
@RequireStepUp(1800)
@RequirePermissions(Permission.CustomersRead)
@RateLimit({
  name: 'admin-customers',
  limit: 60,
  windowSeconds: 60,
  key: 'principal',
})
export class CustomerLookupController {
  constructor(private readonly lookup: CustomerLookupService) {}

  /** POST, not GET: the searched email/phone must not end up in URLs (CDN, load-balancer and proxy access logs). */
  @Post('search')
  @HttpCode(200)
  search(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: searchSchema }) q: z.infer<typeof searchSchema>,
    @Req() req: Request,
  ) {
    const by = q.email
      ? ({ by: 'email', value: q.email } as const)
      : q.phone
        ? ({ by: 'phone', value: q.phone } as const)
        : ({ by: 'order', value: q.order! } as const);
    return this.lookup.search(a, by, requestContext(req));
  }

  @Get(':id')
  get(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: z.uuid() }) id: string,
    @Req() req: Request,
  ) {
    return this.lookup.get(a, id, requestContext(req));
  }
}
