import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { paginated } from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { CURRENCY } from '../pricing/money.js';
import { effectivePrice } from '../pricing/price.js';
import type { ListProductsQuery } from './dto/catalog.schemas.js';
import { ProductRatings } from './product-ratings.js';

interface ListingRow {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  brand_name: string | null;
  brand_slug: string | null;
  min_price: number;
  compare_at: number | null;
  on_sale: boolean;
  available: number;
  image_key: string | null;
  price_varies: boolean;
  total: number;
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  productCount: number;
  children: CategoryNode[];
}

/** "Effective price" in SQL; must mirror pricing/price.ts (covered by a parity test). */
const SALE_ACTIVE = Prisma.sql`(pv.sale_price_minor IS NOT NULL AND pv.sale_price_minor < pv.price_minor
  AND (pv.sale_starts_at IS NULL OR pv.sale_starts_at <= now()) AND (pv.sale_ends_at IS NULL OR now() < pv.sale_ends_at))`;

/** Sort keys map to FIXED SQL fragments: user input never reaches ORDER BY. */
const ORDER_BY: Record<string, Prisma.Sql> = {
  newest: Prisma.sql`p.published_at DESC NULLS LAST, p.id DESC`,
  name_asc: Prisma.sql`p.name ASC, p.id ASC`,
  name_desc: Prisma.sql`p.name DESC, p.id DESC`,
  price_asc: Prisma.sql`v.min_price ASC, p.id ASC`,
  price_desc: Prisma.sql`v.min_price DESC, p.id DESC`,
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Public, read-only catalogue. Only PUBLISHED, non-deleted products with at least one active variant are visible. */
@Injectable()
export class CatalogQueryService {
  private readonly mediaBase: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly ratings: ProductRatings,
  ) {
    this.mediaBase = config
      .get('MEDIA_BASE_URL', { infer: true })
      .replace(/\/$/, '');
  }

  imageUrl(key: string | null): string | null {
    return key ? `${this.mediaBase}/${key}` : null;
  }

  async listProducts(q: ListProductsQuery) {
    const where: Prisma.Sql[] = [
      Prisma.sql`p.status = 'PUBLISHED'`,
      Prisma.sql`p.deleted_at IS NULL`,
    ];
    if (q.category) {
      // The category AND all of its active descendants (a "Kitchen" page includes "Kitchen > Storage").
      where.push(Prisma.sql`EXISTS (
        -- UNION (not UNION ALL): the recursion terminates even if two concurrent edits ever created a parent loop.
        WITH RECURSIVE tree AS (
          SELECT id FROM categories WHERE slug = ${q.category} AND is_active
          UNION SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id WHERE c.is_active)
        SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id IN (SELECT id FROM tree))`);
    }
    if (q.brand) where.push(Prisma.sql`b.slug = ${q.brand}`);
    if (q.minPrice !== undefined)
      where.push(Prisma.sql`v.min_price >= ${q.minPrice}`);
    if (q.maxPrice !== undefined)
      where.push(Prisma.sql`v.min_price <= ${q.maxPrice}`);
    if (q.inStock) where.push(Prisma.sql`COALESCE(a.available, 0) > 0`);
    if (q.special) where.push(Prisma.sql`v.on_sale`);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      where.push(Prisma.sql`(
        p.search_vector @@ websearch_to_tsquery('simple', ${q.q})
        OR p.name ILIKE ${like} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM product_variants s WHERE s.product_id = p.id AND s.deleted_at IS NULL AND s.sku ILIKE ${like} ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id AND t.name ILIKE ${like} ESCAPE '\\'))`);
    }

    const sort = q.sort ?? (q.q ? 'relevance' : 'newest');
    const orderBy =
      sort === 'relevance' && q.q
        ? Prisma.sql`ts_rank(p.search_vector, websearch_to_tsquery('simple', ${q.q})) DESC, p.name ASC, p.id ASC`
        : (ORDER_BY[sort] ?? ORDER_BY['newest']!);

    const rows = await this.prisma.$queryRaw<ListingRow[]>`
      WITH v AS (
        SELECT DISTINCT ON (pv.product_id)
          pv.product_id,
          CASE WHEN ${SALE_ACTIVE} THEN pv.sale_price_minor ELSE pv.price_minor END AS min_price,
          CASE WHEN ${SALE_ACTIVE} THEN pv.price_minor END AS compare_at,
          ${SALE_ACTIVE} AS on_sale
        FROM product_variants pv
        WHERE pv.is_active AND pv.deleted_at IS NULL
        ORDER BY pv.product_id, CASE WHEN ${SALE_ACTIVE} THEN pv.sale_price_minor ELSE pv.price_minor END ASC, pv.position ASC
      ),
      vr AS (
        -- Do the active variants have DIFFERENT current prices? Then the card says "from" the lowest one.
        SELECT pv.product_id,
          MIN(CASE WHEN ${SALE_ACTIVE} THEN pv.sale_price_minor ELSE pv.price_minor END)
            <> MAX(CASE WHEN ${SALE_ACTIVE} THEN pv.sale_price_minor ELSE pv.price_minor END) AS varies
        FROM product_variants pv
        WHERE pv.is_active AND pv.deleted_at IS NULL
        GROUP BY pv.product_id
      ),
      a AS (
        SELECT pv.product_id, SUM(i.on_hand - i.reserved)::int AS available
        FROM product_variants pv
        JOIN inventory i ON i.variant_id = pv.id
        JOIN warehouses w ON w.id = i.warehouse_id AND w.is_active
        WHERE pv.is_active AND pv.deleted_at IS NULL
        GROUP BY pv.product_id
      )
      SELECT p.id, p.slug, p.name, p.summary, b.name AS brand_name, b.slug AS brand_slug,
             v.min_price, v.compare_at, v.on_sale, COALESCE(a.available, 0)::int AS available,
             (SELECT pi.storage_key FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.position, pi.created_at LIMIT 1) AS image_key,
             COALESCE(vr.varies, false) AS price_varies,
             COUNT(*) OVER ()::int AS total
      FROM products p
      JOIN v ON v.product_id = p.id
      LEFT JOIN vr ON vr.product_id = p.id
      LEFT JOIN a ON a.product_id = p.id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

    const total =
      rows[0]?.total ?? (q.page > 1 ? await this.countOnly(where) : 0);
    // Ratings belong to the reviews module: asked for through its registered source, never read from its tables.
    const ratings = await this.ratings.forProducts(rows.map((r) => r.id));
    return paginated(
      rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        summary: r.summary,
        brand: r.brand_slug ? { name: r.brand_name, slug: r.brand_slug } : null,
        price: {
          amountMinor: r.min_price,
          compareAtMinor: r.compare_at,
          onSale: r.on_sale,
          currency: CURRENCY,
          /** The variants cost different amounts: show "from" before the lowest price. */
          fromPrice: r.price_varies,
        },
        inStock: r.available > 0,
        imageUrl: this.imageUrl(r.image_key),
        rating: ratings.get(r.id)!,
      })),
      total,
      q,
    );
  }

  /** Page beyond the end: still report the real total. */
  private async countOnly(where: Prisma.Sql[]): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
      WITH v AS (
        SELECT DISTINCT ON (pv.product_id) pv.product_id,
          CASE WHEN ${SALE_ACTIVE} THEN pv.sale_price_minor ELSE pv.price_minor END AS min_price, ${SALE_ACTIVE} AS on_sale
        FROM product_variants pv WHERE pv.is_active AND pv.deleted_at IS NULL
        ORDER BY pv.product_id, CASE WHEN ${SALE_ACTIVE} THEN pv.sale_price_minor ELSE pv.price_minor END ASC),
      a AS (SELECT pv.product_id, SUM(i.on_hand - i.reserved)::int AS available FROM product_variants pv
            JOIN inventory i ON i.variant_id = pv.id JOIN warehouses w ON w.id = i.warehouse_id AND w.is_active
            WHERE pv.is_active AND pv.deleted_at IS NULL GROUP BY pv.product_id)
      SELECT COUNT(*)::int AS n FROM products p JOIN v ON v.product_id = p.id LEFT JOIN a ON a.product_id = p.id
      LEFT JOIN brands b ON b.id = p.brand_id WHERE ${Prisma.join(where, ' AND ')}`;
    return row?.n ?? 0;
  }

  async getProduct(slug: string) {
    const p = await this.prisma.product.findFirst({
      where: { slug, status: 'PUBLISHED', deletedAt: null },
      include: {
        brand: { select: { name: true, slug: true } },
        categories: {
          select: {
            category: { select: { name: true, slug: true, isActive: true } },
          },
        },
        tags: { select: { tag: { select: { name: true } } } },
        attributes: {
          orderBy: { position: 'asc' },
          select: { name: true, value: true },
        },
        images: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: { storageKey: true, altText: true, variantId: true },
        },
        variants: {
          where: { isActive: true, deletedAt: null },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!p || p.variants.length === 0)
      throw new NotFoundException('Product not found');
    const stock = await this.inventory.availability(
      p.variants.map((v) => v.id),
    );
    const now = new Date();
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      summary: p.summary,
      descriptionHtml: p.descriptionHtml,
      brand: p.brand,
      categories: p.categories
        .filter((c) => c.category.isActive)
        .map((c) => ({ name: c.category.name, slug: c.category.slug })),
      tags: p.tags.map((t) => t.tag.name),
      attributes: p.attributes,
      images: p.images.map((i) => ({
        url: this.imageUrl(i.storageKey),
        altText: i.altText,
        variantId: i.variantId,
      })),
      gstRateBps: p.gstRateBps,
      variants: p.variants.map((v) => {
        const price = effectivePrice(v, now);
        const s = stock.get(v.id);
        // Exact stock levels are not disclosed to the public: only in-stock / low-stock signals.
        return {
          id: v.id,
          sku: v.sku,
          name: v.name,
          optionValues: v.optionValues,
          price: {
            amountMinor: price.unitPriceMinor,
            compareAtMinor: price.compareAtMinor,
            onSale: price.onSale,
            currency: CURRENCY,
          },
          inStock: (s?.available ?? 0) > 0,
          lowStock: s?.lowStock ?? false,
        };
      }),
    };
  }

  /** Resolves a public slug to a published product id (404 otherwise: drafts and archived items do not exist publicly). */
  async resolvePublished(slug: string): Promise<{ id: string; name: string }> {
    const p = await this.prisma.product.findFirst({
      where: { slug, status: 'PUBLISHED', deletedAt: null },
      select: { id: true, name: true },
    });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  /**
   * Compact cards for a set of product ids (wishlist, recommendations). Unpublished or deleted products are omitted;
   * the order of `ids` is preserved. Price comes from the single effective-price rule.
   */
  async summaries(ids: readonly string[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...ids] }, status: 'PUBLISHED', deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        brand: { select: { name: true, slug: true } },
        images: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          take: 1,
          select: { storageKey: true },
        },
        variants: {
          where: { isActive: true, deletedAt: null },
          orderBy: { position: 'asc' },
        },
      },
    });
    const stock = await this.inventory.availability(
      rows.flatMap((r) => r.variants.map((v) => v.id)),
    );
    const now = new Date();
    const byId = new Map(
      rows
        .filter((r) => r.variants.length > 0)
        .map((r) => {
          const prices = r.variants.map((v) => effectivePrice(v, now));
          const best = prices.reduce((a, b) =>
            b.unitPriceMinor < a.unitPriceMinor ? b : a,
          );
          return [
            r.id,
            {
              id: r.id,
              slug: r.slug,
              name: r.name,
              brand: r.brand,
              price: {
                amountMinor: best.unitPriceMinor,
                compareAtMinor: best.compareAtMinor,
                onSale: best.onSale,
                currency: CURRENCY,
              },
              inStock: r.variants.some(
                (v) => (stock.get(v.id)?.available ?? 0) > 0,
              ),
              imageUrl: this.imageUrl(r.images[0]?.storageKey ?? null),
            },
          ] as const;
        }),
    );
    return ids.flatMap((id) => {
      const s = byId.get(id);
      return s ? [s] : [];
    });
  }

  /** Side-by-side comparison of up to 4 products (full public detail, so attributes line up). */
  async compare(slugs: readonly string[]) {
    return Promise.all(slugs.map((s) => this.getProduct(s)));
  }

  /** Category tree with counts of published products in each subtree (a product counts once per subtree). */
  async categoryTree() {
    const [categories, counts] = await Promise.all([
      this.prisma.category.findMany({
        where: { isActive: true },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: { id: true, parentId: true, name: true, slug: true },
      }),
      this.prisma.$queryRaw<{ id: string; n: number }[]>`
        WITH RECURSIVE closure AS (
          SELECT id AS ancestor, id AS descendant FROM categories WHERE is_active
          UNION SELECT c.ancestor, ch.id FROM closure c JOIN categories ch ON ch.parent_id = c.descendant WHERE ch.is_active)
        SELECT c.ancestor AS id, COUNT(DISTINCT pc.product_id)::int AS n
        FROM closure c
        JOIN product_categories pc ON pc.category_id = c.descendant
        JOIN products p ON p.id = pc.product_id AND p.status = 'PUBLISHED' AND p.deleted_at IS NULL
        GROUP BY c.ancestor`,
    ]);
    const countOf = new Map(counts.map((c) => [c.id, c.n]));
    type Node = CategoryNode;
    const nodes = new Map<string, Node>(
      categories.map((c) => [
        c.id,
        {
          id: c.id,
          name: c.name,
          slug: c.slug,
          productCount: countOf.get(c.id) ?? 0,
          children: [],
        },
      ]),
    );
    const roots: Node[] = [];
    for (const c of categories) {
      const node = nodes.get(c.id)!;
      const parent = c.parentId ? nodes.get(c.parentId) : undefined;
      if (parent) parent.children.push(node);
      else if (!c.parentId) roots.push(node); // children of an inactive parent are hidden with it
    }
    return roots;
  }

  /** Brands with their published product count; with `category`, only brands that have products in it (and below). */
  async brands(category?: string) {
    const inCategory = category
      ? Prisma.sql`AND EXISTS (
          WITH RECURSIVE tree AS (
            SELECT id FROM categories WHERE slug = ${category} AND is_active
            UNION SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id WHERE c.is_active)
          SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id IN (SELECT id FROM tree))`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { name: string; slug: string; n: number }[]
    >`
      SELECT b.name, b.slug, COUNT(p.id)::int AS n
      FROM brands b LEFT JOIN products p ON p.brand_id = b.id AND p.status = 'PUBLISHED' AND p.deleted_at IS NULL ${inCategory}
      GROUP BY b.id
      ${category ? Prisma.sql`HAVING COUNT(p.id) > 0` : Prisma.empty}
      ORDER BY b.name`;
    return rows.map((r) => ({ name: r.name, slug: r.slug, productCount: r.n }));
  }
}
