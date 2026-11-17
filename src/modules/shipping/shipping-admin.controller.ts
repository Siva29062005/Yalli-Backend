import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
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
import { ShippingService } from './shipping.service.js';

const fields = {
  code: z.string().regex(/^[A-Z0-9_]{2,30}$/, 'Use A-Z, 0-9 and _ (2-30)'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(200).nullable().optional(),
  baseMinor: z.number().int().min(0).max(100_000_000),
  freeAboveMinor: z
    .number()
    .int()
    .min(1)
    .max(1_000_000_000)
    .nullable()
    .optional(),
  etaMinDays: z.number().int().min(0).max(90),
  etaMaxDays: z.number().int().min(0).max(90),
  states: z.array(z.string().trim().min(2).max(60)).max(40).optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
  isActive: z.boolean().optional(),
};
const createSchema = z.object(fields).strict();
const { code: _code, ...updatable } = fields;
const updateSchema = z
  .object({
    name: updatable.name.optional(),
    description: updatable.description,
    baseMinor: updatable.baseMinor.optional(),
    freeAboveMinor: updatable.freeAboveMinor,
    etaMinDays: updatable.etaMinDays.optional(),
    etaMaxDays: updatable.etaMaxDays.optional(),
    states: updatable.states,
    sortOrder: updatable.sortOrder,
    isActive: updatable.isActive,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

@ApiTags('admin-shipping')
@Controller('admin/shipping-methods')
@RequireStepUp(1800)
@RequirePermissions(Permission.ShipmentsManage)
@RateLimit({
  name: 'admin-shipping',
  limit: 60,
  windowSeconds: 60,
  key: 'principal',
})
export class ShippingAdminController {
  constructor(private readonly shipping: ShippingService) {}

  @Get()
  list() {
    return this.shipping.listMethods();
  }

  @Post()
  create(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: createSchema }) dto: z.infer<typeof createSchema>,
    @Req() req: Request,
  ) {
    return this.shipping.createMethod(a, dto, requestContext(req));
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: updateSchema }) dto: z.infer<typeof updateSchema>,
    @Req() req: Request,
  ) {
    return this.shipping.updateMethod(a, id, dto, requestContext(req));
  }
}
