import {
  Body,
  Controller,
  Get,
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
import { Permission } from '../access/permissions.js';
import { requestContext } from '../audit/audit.service.js';
import { CouponService } from './coupon.service.js';

const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const fields = {
  code: z.string().trim().min(3).max(40),
  description: z.string().trim().max(200).optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  percentBps: z.number().int().min(1).max(10_000).optional(),
  amountMinor: z.number().int().min(1).max(100_000_000).optional(),
  maxDiscountMinor: z
    .number()
    .int()
    .min(1)
    .max(100_000_000)
    .nullable()
    .optional(),
  scope: z.enum(['ALL_ITEMS', 'PRODUCTS', 'CATEGORIES']).default('ALL_ITEMS'),
  productIds: z.array(z.uuid()).max(500).optional(),
  categoryIds: z.array(z.uuid()).max(100).optional(),
  minCartMinor: z.number().int().min(0).max(100_000_000).optional(),
  startsAt: isoDate.nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  maxRedemptions: z.number().int().min(1).max(10_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(1_000).nullable().optional(),
  isActive: z.boolean().optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z
  .object(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([k]) => k !== 'code')
        .map(([k, v]) => [k, (v as z.ZodType).optional()]),
    ) as Omit<
      { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> },
      'code'
    >,
  )
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

@ApiTags('admin-coupons')
@Controller('admin/coupons')
@RequireStepUp(1800)
@RequirePermissions(Permission.CouponsManage)
export class CouponsAdminController {
  constructor(private readonly coupons: CouponService) {}

  @Get()
  list(
    @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>,
  ) {
    return this.coupons.list(q);
  }

  @Get(':id')
  get(@Param('id', { schema: z.uuid() }) id: string) {
    return this.coupons.get(id);
  }

  @Post()
  create(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: createSchema }) dto: z.infer<typeof createSchema>,
    @Req() req: Request,
  ) {
    return this.coupons.create(a, dto, requestContext(req));
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: updateSchema }) dto: z.infer<typeof updateSchema>,
    @Req() req: Request,
  ) {
    return this.coupons.update(
      a,
      id,
      dto as Partial<Parameters<CouponService['create']>[1]>,
      requestContext(req),
    );
  }
}
