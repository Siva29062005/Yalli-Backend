import { ConflictException, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  paginated,
  skipTake,
  type PaginationInput,
} from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { CatalogQueryService } from '../catalog/catalog-query.service.js';

export const WISHLIST_LIMIT = 200;

@Injectable()
export class WishlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogQueryService,
  ) {}

  async list(principal: AuthPrincipal, q: PaginationInput) {
    const where = { userId: principal.userId };
    const [rows, total] = await Promise.all([
      this.prisma.wishlistItem.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...skipTake(q),
        select: { productId: true, createdAt: true },
      }),
      this.prisma.wishlistItem.count({ where }),
    ]);
    const cards = await this.catalog.summaries(rows.map((r) => r.productId));
    const added = new Map(rows.map((r) => [r.productId, r.createdAt]));
    // A product that was unpublished since it was saved simply drops out of the cards (it stays saved).
    return paginated(
      cards.map((c) => ({ ...c, addedAt: added.get(c.id) })),
      total,
      q,
    );
  }

  /** Idempotent: saving a product twice is fine and does not count twice. */
  async add(principal: AuthPrincipal, slug: string): Promise<{ saved: true }> {
    const product = await this.catalog.resolvePublished(slug);
    const existing = await this.prisma.wishlistItem.findUnique({
      where: {
        userId_productId: { userId: principal.userId, productId: product.id },
      },
    });
    if (existing) return { saved: true };
    const count = await this.prisma.wishlistItem.count({
      where: { userId: principal.userId },
    });
    if (count >= WISHLIST_LIMIT)
      throw new ConflictException({
        message: `Your wishlist is full (${WISHLIST_LIMIT} items)`,
        code: 'WISHLIST_FULL',
      });
    await this.prisma.wishlistItem.createMany({
      data: [{ userId: principal.userId, productId: product.id }],
      skipDuplicates: true, // a concurrent double click is harmless
    });
    return { saved: true };
  }

  async remove(principal: AuthPrincipal, slug: string): Promise<void> {
    // Idempotent and identical for an unknown slug, an unpublished product and an item that is not saved: the response
    // must not reveal which unpublished products exist. Scoped to the caller's own rows.
    await this.prisma.wishlistItem.deleteMany({
      where: { userId: principal.userId, product: { slug } },
    });
  }
}
