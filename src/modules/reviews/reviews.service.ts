import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import {
  paginated,
  skipTake,
  type PaginationInput,
} from '../../common/http/pagination.js';
import type { ReviewStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { CatalogQueryService } from '../catalog/catalog-query.service.js';
import {
  ProductRatings,
  type ProductRating,
  type ProductRatingSource,
} from '../catalog/product-ratings.js';
import { OrderService } from '../orders/order.service.js';
import { cleanReviewText, displayName, summarise } from './review-rules.js';

export interface ReviewInput {
  rating: number;
  title?: string | null | undefined;
  body: string;
}

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002';
const tooShort = () =>
  new BadRequestException({
    message: 'Please write a little more (at least 10 characters of text)',
    code: ErrorCode.ValidationFailed,
  });

@Injectable()
export class ReviewsService implements ProductRatingSource, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogQueryService,
    private readonly orders: OrderService,
    private readonly audit: AuditService,
    private readonly ratings: ProductRatings,
  ) {}

  onModuleInit(): void {
    this.ratings.register(this);
  }

  /** Approved-review ratings for listing cards; same rounding as the product page summary (`summarise`). */
  async ratingsFor(
    productIds: readonly string[],
  ): Promise<Map<string, ProductRating>> {
    const groups = await this.prisma.productReview.groupBy({
      by: ['productId', 'rating'],
      where: { productId: { in: [...productIds] }, status: 'APPROVED' },
      _count: { _all: true },
    });
    const counts = new Map<string, Partial<Record<number, number>>>();
    for (const g of groups) {
      const c = counts.get(g.productId) ?? {};
      c[g.rating] = g._count._all;
      counts.set(g.productId, c);
    }
    return new Map(
      [...counts].map(([id, c]) => {
        const { average, count } = summarise(c);
        return [id, { average, count }];
      }),
    );
  }

  // -------------------------------------------------------------------------------------- public

  async summary(slug: string) {
    const { id } = await this.catalog.resolvePublished(slug);
    const groups = await this.prisma.productReview.groupBy({
      by: ['rating'],
      where: { productId: id, status: 'APPROVED' },
      _count: { _all: true },
    });
    return summarise(
      Object.fromEntries(groups.map((g) => [g.rating, g._count._all])),
    );
  }

  async listForProduct(slug: string, q: PaginationInput) {
    const { id } = await this.catalog.resolvePublished(slug);
    const where = { productId: id, status: 'APPROVED' as const };
    const [rows, total] = await Promise.all([
      this.prisma.productReview.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...skipTake(q),
        select: {
          id: true,
          rating: true,
          title: true,
          body: true,
          createdAt: true,
          user: {
            select: {
              customer: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.productReview.count({ where }),
    ]);
    return paginated(
      rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        verifiedPurchase: true,
        reviewer: displayName(
          r.user.customer?.firstName ?? '',
          r.user.customer?.lastName ?? '',
        ),
        createdAt: r.createdAt,
      })),
      total,
      q,
    );
  }

  // ------------------------------------------------------------------------------------ customer

  async create(principal: AuthPrincipal, slug: string, input: ReviewInput) {
    const product = await this.catalog.resolvePublished(slug);
    const text = cleanReviewText(input);
    if (!text) throw tooShort();
    if (!(await this.orders.hasReceivedProduct(principal.userId, product.id)))
      throw new ForbiddenException({
        message: 'Only customers who received this product can review it',
        code: 'REVIEW_REQUIRES_PURCHASE',
      });
    try {
      const r = await this.prisma.productReview.create({
        data: {
          productId: product.id,
          userId: principal.userId,
          rating: input.rating,
          ...text,
        },
      });
      return this.own(r);
    } catch (e) {
      if (isUnique(e))
        throw new ConflictException({
          message:
            'You have already reviewed this product. Edit your review instead.',
          code: 'REVIEW_EXISTS',
        });
      throw e;
    }
  }

  async listOwn(principal: AuthPrincipal, q: PaginationInput) {
    const where = { userId: principal.userId };
    const [rows, total] = await Promise.all([
      this.prisma.productReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
        include: { product: { select: { slug: true, name: true } } },
      }),
      this.prisma.productReview.count({ where }),
    ]);
    return paginated(
      rows.map((r) => ({ ...this.own(r), product: r.product })),
      total,
      q,
    );
  }

  /** Editing sends the review back to moderation: an approved review cannot be swapped for different text unseen. */
  async updateOwn(
    principal: AuthPrincipal,
    id: string,
    patch: Partial<ReviewInput>,
  ) {
    const current = await this.prisma.productReview.findFirst({
      where: { id, userId: principal.userId },
    });
    if (!current) throw new NotFoundException('Review not found');
    const text = cleanReviewText({
      title: patch.title === undefined ? current.title : patch.title,
      body: patch.body ?? current.body,
    });
    if (!text) throw tooShort();
    const r = await this.prisma.productReview.update({
      where: { id },
      data: {
        rating: patch.rating ?? current.rating,
        ...text,
        status: 'PENDING',
        moderatedById: null,
        moderatedAt: null,
        moderationNote: null,
      },
    });
    return this.own(r);
  }

  async removeOwn(principal: AuthPrincipal, id: string): Promise<void> {
    const { count } = await this.prisma.productReview.deleteMany({
      where: { id, userId: principal.userId },
    });
    if (count === 0) throw new NotFoundException('Review not found');
  }

  private own(r: {
    id: string;
    rating: number;
    title: string | null;
    body: string;
    status: ReviewStatus;
    moderationNote: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      status: r.status,
      moderationNote: r.status === 'REJECTED' ? r.moderationNote : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  // -------------------------------------------------------------------------------------- admin

  async adminList(q: PaginationInput & { status?: ReviewStatus | undefined }) {
    const where = { status: q.status ?? ('PENDING' as const) };
    const [rows, total] = await Promise.all([
      this.prisma.productReview.findMany({
        where,
        orderBy: { createdAt: 'asc' }, // oldest first: a moderation queue
        ...skipTake(q),
        include: {
          product: { select: { slug: true, name: true } },
          user: {
            select: {
              customer: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.productReview.count({ where }),
    ]);
    return paginated(
      rows.map((r) => ({
        id: r.id,
        product: r.product,
        reviewer: displayName(
          r.user.customer?.firstName ?? '',
          r.user.customer?.lastName ?? '',
        ),
        rating: r.rating,
        title: r.title,
        body: r.body,
        status: r.status,
        moderationNote: r.moderationNote,
        createdAt: r.createdAt,
      })),
      total,
      q,
    );
  }

  async decide(
    actor: AuthPrincipal,
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string | undefined,
    ctx: RequestContext,
  ) {
    const now = new Date();
    // Conditional update: two moderators cannot both "decide" the same pending review.
    const { count } = await this.prisma.productReview.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: decision,
        moderatedById: actor.userId,
        moderatedAt: now,
        moderationNote: note ?? null,
      },
    });
    if (count === 0) {
      const exists = await this.prisma.productReview.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!exists) throw new NotFoundException('Review not found');
      throw new ConflictException({
        message: `This review was already ${exists.status.toLowerCase()}`,
        code: 'REVIEW_ALREADY_DECIDED',
      });
    }
    await this.audit.record({
      action: AuditAction.ReviewDecided,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'review',
      resourceId: id,
      metadata: { decision },
    });
    return { id, status: decision };
  }

  /**
   * Takes a PUBLISHED review down (for example one found abusive after approval): APPROVED -> REJECTED with the
   * reason, which the author sees. Conditional, like `decide`: only an approved review can be taken down.
   */
  async takeDown(
    actor: AuthPrincipal,
    id: string,
    note: string,
    ctx: RequestContext,
  ) {
    const { count } = await this.prisma.productReview.updateMany({
      where: { id, status: 'APPROVED' },
      data: {
        status: 'REJECTED',
        moderatedById: actor.userId,
        moderatedAt: new Date(),
        moderationNote: note,
      },
    });
    if (count === 0) {
      const exists = await this.prisma.productReview.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!exists) throw new NotFoundException('Review not found');
      throw new ConflictException({
        message: 'Only a published review can be taken down',
        code: 'REVIEW_NOT_PUBLISHED',
      });
    }
    await this.audit.record({
      action: AuditAction.ReviewTakenDown,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'review',
      resourceId: id,
    });
    return { id, status: 'REJECTED' as const };
  }
}
