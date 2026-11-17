import {
  Body,
  Controller,
  Get,
  NotFoundException,
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
import { paginated, paginationSchema } from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { Permission } from '../access/permissions.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, requestContext } from '../audit/audit.service.js';
import { InventoryService } from './inventory.service.js';

const adjustSchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    warehouseCode: z.string().trim().max(20).optional(),
    delta: z
      .number()
      .int()
      .min(-100_000)
      .max(100_000)
      .refine((n) => n !== 0, { message: 'delta must not be zero' }),
    type: z.enum(['RECEIPT', 'ADJUSTMENT', 'RETURN']).default('ADJUSTMENT'),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();
const listSchema = paginationSchema
  .extend({
    sku: z.string().trim().max(64).optional(),
    lowStock: z.enum(['true', 'false']).optional(),
  })
  .strict();
const movementsSchema = paginationSchema
  .extend({ sku: z.string().trim().min(1).max(64) })
  .strict();

@ApiTags('admin-inventory')
@Controller('admin')
@RequireStepUp(1800)
export class InventoryAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  @Get('warehouses')
  @RequirePermissions(Permission.InventoryRead)
  warehouses() {
    return this.prisma.warehouse.findMany({
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        isDefault: true,
        isActive: true,
      },
    });
  }

  @Get('inventory')
  @RequirePermissions(Permission.InventoryRead)
  async list(@Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    const rows = await this.prisma.inventory.findMany({
      where: q.sku
        ? { variant: { sku: { contains: q.sku, mode: 'insensitive' } } }
        : {},
      orderBy: { updatedAt: 'desc' },
      include: {
        variant: { select: { sku: true, product: { select: { name: true } } } },
        warehouse: { select: { code: true } },
      },
    });
    const items = rows
      .map((r) => ({
        sku: r.variant.sku,
        product: r.variant.product.name,
        warehouse: r.warehouse.code,
        onHand: r.onHand,
        reserved: r.reserved,
        available: r.onHand - r.reserved,
        lowStockThreshold: r.lowStockThreshold,
      }))
      .filter(
        (r) => q.lowStock !== 'true' || r.available <= r.lowStockThreshold,
      );
    return paginated(
      items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      items.length,
      q,
    );
  }

  @Post('inventory/adjustments')
  @RequirePermissions(Permission.InventoryAdjust)
  async adjust(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body({ schema: adjustSchema }) dto: z.infer<typeof adjustSchema>,
    @Req() req: Request,
  ) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { sku: { equals: dto.sku, mode: 'insensitive' } },
      select: { id: true, sku: true },
    });
    if (!variant) throw new NotFoundException('Unknown SKU');
    const warehouse = dto.warehouseCode
      ? await this.prisma.warehouse.findUnique({
          where: { code: dto.warehouseCode },
        })
      : null;
    if (dto.warehouseCode && !warehouse)
      throw new NotFoundException('Unknown warehouse');
    const result = await this.inventory.adjust({
      variantId: variant.id,
      ...(warehouse ? { warehouseId: warehouse.id } : {}),
      delta: dto.delta,
      reason: dto.reason,
      actorId: actor.userId,
      type: dto.type,
    });
    await this.audit.record({
      action: AuditAction.InventoryAdjusted,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...requestContext(req),
      resourceType: 'variant',
      resourceId: variant.id,
      metadata: {
        sku: variant.sku,
        delta: dto.delta,
        type: dto.type,
        reason: dto.reason,
        onHandAfter: result.onHand,
      },
    });
    return { sku: variant.sku, ...result };
  }

  @Get('inventory/movements')
  @RequirePermissions(Permission.InventoryRead)
  async movements(
    @Query({ schema: movementsSchema }) q: z.infer<typeof movementsSchema>,
  ) {
    const where = {
      variant: { sku: { equals: q.sku, mode: 'insensitive' as const } },
    };
    const [items, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          type: true,
          onHandDelta: true,
          reservedDelta: true,
          onHandAfter: true,
          reservedAfter: true,
          reason: true,
          referenceType: true,
          referenceId: true,
          actorId: true,
          createdAt: true,
        },
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return paginated(items, total, q);
  }
}
