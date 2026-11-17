import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import {
  paginated,
  type PaginationInput,
} from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Coupon, Prisma } from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import type { CouponRule } from '../pricing/cart-pricing.js';

type Tx = Prisma.TransactionClient;
type CouponWithScope = Coupon & {
  products: { productId: string }[];
  categories: { categoryId: string }[];
};

export type CouponUnusable = 'INVALID' | 'EXHAUSTED' | 'CUSTOMER_LIMIT';

export const normalizeCouponCode = (code: string): string =>
  code.trim().toUpperCase();
export const COUPON_CODE = /^[A-Z0-9_-]{3,40}$/;

export interface CouponInput {
  code: string;
  description?: string | undefined;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  percentBps?: number | undefined;
  amountMinor?: number | undefined;
  maxDiscountMinor?: number | null | undefined;
  scope: 'ALL_ITEMS' | 'PRODUCTS' | 'CATEGORIES';
  productIds?: string[] | undefined;
  categoryIds?: string[] | undefined;
  minCartMinor?: number | undefined;
  startsAt?: Date | null | undefined;
  expiresAt?: Date | null | undefined;
  maxRedemptions?: number | null | undefined;
  perCustomerLimit?: number | null | undefined;
  isActive?: boolean | undefined;
}

@Injectable()
export class CouponService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findByCode(
    rawCode: string,
    db: Tx | PrismaService = this.prisma, // pass the transaction when inside one (see inventory.availability)
  ): Promise<CouponWithScope | null> {
    const code = normalizeCouponCode(rawCode);
    if (!COUPON_CODE.test(code)) return null;
    return db.coupon.findUnique({
      where: { code },
      include: {
        products: { select: { productId: true } },
        categories: { select: { categoryId: true } },
      },
    });
  }

  toRule(c: CouponWithScope): CouponRule {
    return {
      code: c.code,
      discountType: c.discountType,
      percentBps: c.percentBps,
      amountMinor: c.amountMinor,
      maxDiscountMinor: c.maxDiscountMinor,
      scope: c.scope,
      productIds: new Set(c.products.map((p) => p.productId)),
      categoryIds: new Set(c.categories.map((x) => x.categoryId)),
      minCartMinor: c.minCartMinor,
    };
  }

  /** Can this coupon be used right now (by this customer, if known)? Cart-dependent rules live in priceCart. */
  async unusableReason(
    c: Coupon,
    userId: string | null,
    now = new Date(),
    db: Tx | PrismaService = this.prisma,
  ): Promise<CouponUnusable | null> {
    if (
      !c.isActive ||
      (c.startsAt && c.startsAt > now) ||
      (c.expiresAt && c.expiresAt <= now)
    )
      return 'INVALID';
    if (c.maxRedemptions !== null && c.redeemedCount >= c.maxRedemptions)
      return 'EXHAUSTED';
    if (userId && c.perCustomerLimit !== null) {
      const used = await db.couponRedemption.count({
        where: { couponId: c.id, userId },
      });
      if (used >= c.perCustomerLimit) return 'CUSTOMER_LIMIT';
    }
    return null;
  }

  /**
   * Records a redemption inside the CALLER's transaction (checkout, Phase 5). Race-safe:
   *  - the global limit is a conditional increment (and a DB CHECK makes over-redemption impossible),
   *  - the per-customer limit is checked under a transaction-scoped advisory lock for (coupon, customer),
   *  - a repeat for the same reference is a no-op (unique constraint) - idempotent.
   */
  async redeemInTx(
    tx: Tx,
    input: {
      couponId: string;
      userId: string;
      referenceType: string;
      referenceId: string;
      discountMinor: number;
    },
  ): Promise<'redeemed' | 'already-redeemed'> {
    const existing = await tx.couponRedemption.findUnique({
      where: {
        couponId_referenceType_referenceId: {
          couponId: input.couponId,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        },
      },
    });
    if (existing) return 'already-redeemed';

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coupon:${input.couponId}:${input.userId}`}, 0))`;
    const coupon = await tx.coupon.findUniqueOrThrow({
      where: { id: input.couponId },
    });
    if (coupon.perCustomerLimit !== null) {
      const used = await tx.couponRedemption.count({
        where: { couponId: coupon.id, userId: input.userId },
      });
      if (used >= coupon.perCustomerLimit)
        throw new ConflictException({
          message: 'You have already used this coupon',
          code: 'COUPON_CUSTOMER_LIMIT',
        });
    }
    const bumped = await tx.$executeRaw`
      UPDATE coupons SET redeemed_count = redeemed_count + 1, updated_at = now()
      WHERE id = ${coupon.id}::uuid AND is_active
        AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
        AND (starts_at IS NULL OR starts_at <= now()) AND (expires_at IS NULL OR expires_at > now())`;
    if (bumped !== 1)
      throw new ConflictException({
        message: 'This coupon is no longer available',
        code: 'COUPON_UNAVAILABLE',
      });
    await tx.couponRedemption.create({ data: input });
    return 'redeemed';
  }

  /**
   * Gives a redemption back when an UNPAID order is abandoned (the customer never bought). Paid orders keep their
   * redemption even if later refunded (business policy: a used coupon stays used).
   */
  async releaseInTx(
    tx: Tx,
    referenceType: string,
    referenceId: string,
  ): Promise<void> {
    const redemptions = await tx.couponRedemption.findMany({
      where: { referenceType, referenceId },
    });
    for (const r of redemptions) {
      const deleted = await tx.couponRedemption.deleteMany({
        where: { id: r.id },
      });
      if (deleted.count === 1)
        await tx.$executeRaw`UPDATE coupons SET redeemed_count = redeemed_count - 1, updated_at = now() WHERE id = ${r.couponId}::uuid AND redeemed_count > 0`;
    }
  }

  // ------------------------------------------------------------------------------------ admin

  async create(actor: AuthPrincipal, input: CouponInput, ctx: RequestContext) {
    const data = await this.validated(input);
    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          ...data.fields,
          products: {
            create: data.productIds.map((productId) => ({ productId })),
          },
          categories: {
            create: data.categoryIds.map((categoryId) => ({ categoryId })),
          },
        },
      });
      await this.audit.record({
        action: AuditAction.CouponCreated,
        outcome: 'SUCCESS',
        actorId: actor.userId,
        ...ctx,
        resourceType: 'coupon',
        resourceId: coupon.id,
        metadata: { code: coupon.code, type: coupon.discountType },
      });
      return this.get(coupon.id);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002')
        throw new ConflictException({
          message: 'A coupon with this code already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
  }

  async update(
    actor: AuthPrincipal,
    id: string,
    patch: Partial<CouponInput>,
    ctx: RequestContext,
  ) {
    const current = await this.get(id);
    const merged: CouponInput = {
      code: current.code,
      description: current.description ?? undefined,
      discountType: current.discountType,
      percentBps: current.percentBps ?? undefined,
      amountMinor: current.amountMinor ?? undefined,
      maxDiscountMinor: current.maxDiscountMinor,
      scope: current.scope,
      productIds: current.products.map((p) => p.productId),
      categoryIds: current.categories.map((c) => c.categoryId),
      minCartMinor: current.minCartMinor,
      startsAt: current.startsAt,
      expiresAt: current.expiresAt,
      maxRedemptions: current.maxRedemptions,
      perCustomerLimit: current.perCustomerLimit,
      isActive: current.isActive,
      ...patch,
    };
    if (
      merged.maxRedemptions != null &&
      merged.maxRedemptions < current.redeemedCount
    ) {
      throw new ConflictException({
        message: `Limit cannot be below the ${current.redeemedCount} redemptions already made`,
        code: ErrorCode.Conflict,
      });
    }
    const data = await this.validated(merged);
    await this.prisma.$transaction([
      this.prisma.coupon.update({ where: { id }, data: data.fields }),
      this.prisma.couponProduct.deleteMany({ where: { couponId: id } }),
      this.prisma.couponProduct.createMany({
        data: data.productIds.map((productId) => ({ couponId: id, productId })),
      }),
      this.prisma.couponCategory.deleteMany({ where: { couponId: id } }),
      this.prisma.couponCategory.createMany({
        data: data.categoryIds.map((categoryId) => ({
          couponId: id,
          categoryId,
        })),
      }),
    ]);
    await this.audit.record({
      action: AuditAction.CouponUpdated,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'coupon',
      resourceId: id,
      metadata: { fields: Object.keys(patch) },
    });
    return this.get(id);
  }

  async get(id: string) {
    const c = await this.prisma.coupon.findUnique({
      where: { id },
      include: {
        products: { select: { productId: true } },
        categories: { select: { categoryId: true } },
      },
    });
    if (!c) throw new NotFoundException('Coupon not found');
    return c;
  }

  async list(q: PaginationInput) {
    const [items, total] = await Promise.all([
      this.prisma.coupon.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.coupon.count(),
    ]);
    return paginated(items, total, q);
  }

  private async validated(input: CouponInput) {
    const code = normalizeCouponCode(input.code);
    const bad = (message: string) =>
      new BadRequestException({ message, code: ErrorCode.ValidationFailed });
    if (!COUPON_CODE.test(code))
      throw bad('Coupon codes use 3-40 letters, digits, - or _');
    if (
      input.discountType === 'PERCENTAGE' &&
      (input.percentBps === undefined || input.amountMinor !== undefined)
    )
      throw bad('Percentage coupons need percentBps (and no amountMinor)');
    if (
      input.discountType === 'FIXED_AMOUNT' &&
      (input.amountMinor === undefined || input.percentBps !== undefined)
    )
      throw bad('Fixed coupons need amountMinor (and no percentBps)');
    const productIds = [...new Set(input.productIds ?? [])];
    const categoryIds = [...new Set(input.categoryIds ?? [])];
    if (input.scope === 'PRODUCTS' && productIds.length === 0)
      throw bad('Product-scoped coupons need productIds');
    if (input.scope === 'CATEGORIES' && categoryIds.length === 0)
      throw bad('Category-scoped coupons need categoryIds');
    if (input.scope !== 'PRODUCTS' && productIds.length > 0)
      throw bad('productIds only apply to PRODUCTS scope');
    if (input.scope !== 'CATEGORIES' && categoryIds.length > 0)
      throw bad('categoryIds only apply to CATEGORIES scope');
    if (
      productIds.length &&
      (await this.prisma.product.count({
        where: { id: { in: productIds } },
      })) !== productIds.length
    )
      throw bad('Unknown product in productIds');
    if (
      categoryIds.length &&
      (await this.prisma.category.count({
        where: { id: { in: categoryIds } },
      })) !== categoryIds.length
    )
      throw bad('Unknown category in categoryIds');
    if (input.startsAt && input.expiresAt && input.expiresAt <= input.startsAt)
      throw bad('expiresAt must be after startsAt');
    return {
      productIds,
      categoryIds,
      fields: {
        code,
        description: input.description ?? null,
        discountType: input.discountType,
        percentBps:
          input.discountType === 'PERCENTAGE' ? input.percentBps! : null,
        amountMinor:
          input.discountType === 'FIXED_AMOUNT' ? input.amountMinor! : null,
        maxDiscountMinor: input.maxDiscountMinor ?? null,
        scope: input.scope,
        minCartMinor: input.minCartMinor ?? 0,
        startsAt: input.startsAt ?? null,
        expiresAt: input.expiresAt ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
        perCustomerLimit: input.perCustomerLimit ?? null,
        isActive: input.isActive ?? true,
      },
    };
  }
}
