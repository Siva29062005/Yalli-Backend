import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import {
  paginated,
  type PaginationInput,
} from '../../common/http/pagination.js';
import {
  sanitizeRichText,
  stripTags,
} from '../../common/utils/sanitize-html.js';
import { slugify, uniqueSlug } from '../../common/utils/slug.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Permission } from '../access/permissions.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { effectivePrice } from '../pricing/price.js';
import { CatalogQueryService } from './catalog-query.service.js';
import type {
  CreateProductDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantDto,
} from './dto/catalog.schemas.js';
import { ImageRejected, reencodeImage } from './media/image-processing.js';
import { detectImageType, MAX_IMAGE_BYTES } from './media/image-validation.js';
import { ObjectStorage } from './media/object-storage.js';

type Tx = Prisma.TransactionClient;
const isUnique = (err: unknown) =>
  (err as { code?: string } | null)?.code === 'P2002';
const PRICE_FIELDS = [
  'priceMinor',
  'salePriceMinor',
  'saleStartsAt',
  'saleEndsAt',
] as const;
const MAX_IMAGES_PER_PRODUCT = 20;

@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger(CatalogAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly storage: ObjectStorage,
    private readonly query: CatalogQueryService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------------------------- brands

  /** Staff brand picker: includes ids (the public list has none) and brands with no published products. */
  async listBrands() {
    return this.prisma.brand.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        // live products (not soft-deleted) that carry the brand: they lose it if the brand is deleted
        _count: { select: { products: { where: { deletedAt: null } } } },
      },
    });
  }

  async createBrand(
    actor: AuthPrincipal,
    dto: { name: string; slug?: string | undefined },
    ctx: RequestContext,
  ) {
    try {
      const brand = await this.prisma.brand.create({
        data: {
          name: stripTags(dto.name),
          slug: dto.slug ?? slugify(dto.name),
        },
      });
      await this.taxonomyAudit(actor, 'brand', brand.id, 'create', ctx);
      return brand;
    } catch (err) {
      if (isUnique(err))
        throw new ConflictException({
          message: 'A brand with this name or slug already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
  }

  async deleteBrand(actor: AuthPrincipal, id: string, ctx: RequestContext) {
    const res = await this.prisma.brand.deleteMany({ where: { id } }); // products keep existing with brand = null
    if (res.count === 0) throw new NotFoundException('Brand not found');
    await this.taxonomyAudit(actor, 'brand', id, 'delete', ctx);
  }

  // ------------------------------------------------------------------------------- categories

  async listCategories() {
    return this.prisma.category.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        parentId: true,
        position: true,
        isActive: true,
        _count: { select: { products: true, children: true } },
      },
    });
  }

  async createCategory(
    actor: AuthPrincipal,
    dto: {
      name: string;
      slug?: string | undefined;
      parentId?: string | null | undefined;
      position?: number | undefined;
      isActive?: boolean | undefined;
    },
    ctx: RequestContext,
  ) {
    if (
      dto.parentId &&
      !(await this.prisma.category.findUnique({
        where: { id: dto.parentId },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException({
        message: 'Parent category not found',
        code: ErrorCode.ValidationFailed,
      });
    }
    try {
      const cat = await this.prisma.category.create({
        data: {
          name: stripTags(dto.name),
          slug: dto.slug ?? slugify(dto.name),
          parentId: dto.parentId ?? null,
          position: dto.position ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
      await this.taxonomyAudit(actor, 'category', cat.id, 'create', ctx);
      return cat;
    } catch (err) {
      if (isUnique(err))
        throw new ConflictException({
          message: 'A category with this slug already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
  }

  async updateCategory(
    actor: AuthPrincipal,
    id: string,
    dto: {
      name?: string | undefined;
      slug?: string | undefined;
      parentId?: string | null | undefined;
      position?: number | undefined;
      isActive?: boolean | undefined;
    },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    if (dto.parentId) await this.assertNoCycle(id, dto.parentId);
    try {
      const cat = await this.prisma.category.update({
        where: { id },
        data: { ...dto, ...(dto.name ? { name: stripTags(dto.name) } : {}) },
      });
      await this.taxonomyAudit(actor, 'category', id, 'update', ctx);
      return cat;
    } catch (err) {
      if (isUnique(err))
        throw new ConflictException({
          message: 'A category with this slug already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
  }

  /** Moving a category under its own descendant would create a loop; walk up from the new parent to be sure. */
  private async assertNoCycle(id: string, newParentId: string) {
    let cursor: string | null = newParentId;
    for (let depth = 0; cursor; depth++) {
      if (cursor === id || depth > 50)
        throw new ConflictException({
          message: 'A category cannot be moved under itself or its descendants',
          code: ErrorCode.Conflict,
        });
      const parent: { parentId: string | null } | null =
        await this.prisma.category.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      if (!parent)
        throw new BadRequestException({
          message: 'Parent category not found',
          code: ErrorCode.ValidationFailed,
        });
      cursor = parent.parentId;
    }
  }

  async deleteCategory(actor: AuthPrincipal, id: string, ctx: RequestContext) {
    const cat = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { children: true, products: true } } },
    });
    if (!cat) throw new NotFoundException('Category not found');
    if (cat._count.children > 0 || cat._count.products > 0) {
      throw new ConflictException({
        message: 'Only empty categories can be deleted; deactivate it instead',
        code: ErrorCode.Conflict,
      });
    }
    await this.prisma.category.delete({ where: { id } });
    await this.taxonomyAudit(actor, 'category', id, 'delete', ctx);
  }

  private taxonomyAudit(
    actor: AuthPrincipal,
    type: string,
    id: string,
    change: string,
    ctx: RequestContext,
  ) {
    return this.audit.record({
      action: AuditAction.CatalogTaxonomyChanged,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: type,
      resourceId: id,
      metadata: { change },
    });
  }

  // --------------------------------------------------------------------------------- products

  async createProduct(
    actor: AuthPrincipal,
    dto: CreateProductDto,
    ctx: RequestContext,
  ) {
    this.assertPricingPermission(actor, dto.variants); // a product cannot be created with prices you may not set
    const slug =
      dto.slug ??
      (await uniqueSlug(
        dto.name,
        async (s) =>
          (await this.prisma.product.count({ where: { slug: s } })) > 0,
        160,
      ));
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await this.assertRefs(tx, dto.brandId ?? null, dto.categoryIds);
        const product = await tx.product.create({
          data: {
            slug,
            name: stripTags(dto.name),
            summary: dto.summary ? stripTags(dto.summary) : null,
            descriptionHtml: sanitizeRichText(dto.descriptionHtml ?? ''),
            brandId: dto.brandId ?? null,
            gstRateBps: dto.gstRateBps ?? 1800,
            hsnCode: dto.hsnCode ?? null,
            categories: {
              create: dto.categoryIds.map((categoryId) => ({ categoryId })),
            },
            attributes: {
              create: (dto.attributes ?? []).map((a, position) => ({
                name: stripTags(a.name),
                value: stripTags(a.value),
                position,
              })),
            },
          },
          select: { id: true },
        });
        await this.setTags(tx, product.id, dto.tags ?? []);
        for (const [i, v] of dto.variants.entries())
          await this.insertVariant(tx, product.id, v, i);
        return product.id;
      });
      await this.audit.record({
        action: AuditAction.ProductCreated,
        outcome: 'SUCCESS',
        actorId: actor.userId,
        ...ctx,
        resourceType: 'product',
        resourceId: id,
        metadata: { slug, variants: dto.variants.length },
      });
      return this.getProduct(id);
    } catch (err) {
      if (isUnique(err))
        throw new ConflictException({
          message: 'A product slug or SKU already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
  }

  async updateProduct(
    actor: AuthPrincipal,
    id: string,
    dto: UpdateProductDto,
    ctx: RequestContext,
  ) {
    await this.requireProduct(id);
    try {
      await this.prisma.$transaction(async (tx) => {
        if (dto.brandId !== undefined || dto.categoryIds)
          await this.assertRefs(tx, dto.brandId ?? null, dto.categoryIds ?? []);
        await tx.product.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: stripTags(dto.name) } : {}),
            ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
            ...(dto.summary !== undefined
              ? { summary: stripTags(dto.summary) }
              : {}),
            ...(dto.descriptionHtml !== undefined
              ? { descriptionHtml: sanitizeRichText(dto.descriptionHtml) }
              : {}),
            ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
            ...(dto.gstRateBps !== undefined
              ? { gstRateBps: dto.gstRateBps }
              : {}),
            ...(dto.hsnCode !== undefined ? { hsnCode: dto.hsnCode } : {}),
          },
        });
        if (dto.categoryIds) {
          await tx.productCategory.deleteMany({ where: { productId: id } });
          await tx.productCategory.createMany({
            data: dto.categoryIds.map((categoryId) => ({
              productId: id,
              categoryId,
            })),
          });
        }
        if (dto.tags) await this.setTags(tx, id, dto.tags);
        if (dto.attributes) {
          await tx.productAttribute.deleteMany({ where: { productId: id } });
          await tx.productAttribute.createMany({
            data: dto.attributes.map((a, position) => ({
              productId: id,
              name: stripTags(a.name),
              value: stripTags(a.value),
              position,
            })),
          });
        }
      });
    } catch (err) {
      if (isUnique(err))
        throw new ConflictException({
          message: 'A product with this slug already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
    await this.audit.record({
      action: AuditAction.ProductUpdated,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'product',
      resourceId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return this.getProduct(id);
  }

  /** DRAFT <-> PUBLISHED, anything -> ARCHIVED. A product needs an active, priced variant to go live. */
  async setStatus(
    actor: AuthPrincipal,
    id: string,
    status: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED',
    ctx: RequestContext,
  ) {
    const product = await this.requireProduct(id);
    if (status === 'PUBLISHED') {
      const live = await this.prisma.productVariant.count({
        where: { productId: id, isActive: true, deletedAt: null },
      });
      if (live === 0)
        throw new ConflictException({
          message: 'Add at least one active variant before publishing',
          code: ErrorCode.Conflict,
        });
    }
    await this.prisma.product.update({
      where: { id },
      data: {
        status,
        ...(status === 'PUBLISHED' && !product.publishedAt
          ? { publishedAt: new Date() }
          : {}),
      },
    });
    await this.audit.record({
      action: AuditAction.ProductStatusChanged,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'product',
      resourceId: id,
      metadata: { from: product.status, to: status },
    });
    return this.getProduct(id);
  }

  /** Soft delete: the row (and its SKUs) stay for order history; it disappears from every storefront query. */
  async deleteProduct(actor: AuthPrincipal, id: string, ctx: RequestContext) {
    await this.requireProduct(id);
    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
    });
    await this.audit.record({
      action: AuditAction.ProductDeleted,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'product',
      resourceId: id,
    });
  }

  // --------------------------------------------------------------------------------- variants

  async addVariant(
    actor: AuthPrincipal,
    productId: string,
    dto: VariantDto,
    ctx: RequestContext,
  ) {
    this.assertPricingPermission(actor, [dto]);
    await this.requireProduct(productId);
    try {
      const variant = await this.prisma.$transaction(async (tx) => {
        const count = await tx.productVariant.count({ where: { productId } });
        return this.insertVariant(tx, productId, dto, count);
      });
      await this.audit.record({
        action: AuditAction.PriceChanged,
        outcome: 'SUCCESS',
        actorId: actor.userId,
        ...ctx,
        resourceType: 'variant',
        resourceId: variant.id,
        metadata: { sku: variant.sku, to: priceSnapshot(variant) },
      });
      return variant;
    } catch (err) {
      if (isUnique(err))
        throw new ConflictException({
          message: 'This SKU already exists',
          code: ErrorCode.Conflict,
        });
      throw err;
    }
  }

  /** Price edits additionally require pricing.update and are audited with before/after values. */
  async updateVariant(
    actor: AuthPrincipal,
    variantId: string,
    dto: UpdateVariantDto,
    ctx: RequestContext,
  ) {
    const before = await this.prisma.productVariant.findFirst({
      where: { id: variantId, deletedAt: null },
    });
    if (!before) throw new NotFoundException('Variant not found');
    // A price field sent with its CURRENT value is not a price change: an editor saving the name or weight needs no
    // pricing.update and leaves no price-change audit entry.
    const touchesPrice = PRICE_FIELDS.some(
      (f) => dto[f] !== undefined && !samePriceValue(dto[f], before[f]),
    );
    if (touchesPrice && !actor.permissions.has(Permission.PricingUpdate)) {
      throw new ForbiddenException({
        message: 'Changing prices requires the pricing.update permission',
        code: ErrorCode.Forbidden,
      });
    }
    const merged = {
      ...priceSnapshot(before),
      ...Object.fromEntries(
        PRICE_FIELDS.filter((f) => dto[f] !== undefined).map((f) => [
          f,
          dto[f],
        ]),
      ),
    } as ReturnType<typeof priceSnapshot>;
    if (
      merged.salePriceMinor !== null &&
      merged.salePriceMinor >= merged.priceMinor
    ) {
      throw new BadRequestException({
        message: 'salePriceMinor must be lower than priceMinor',
        code: ErrorCode.ValidationFailed,
      });
    }
    if (
      merged.saleStartsAt &&
      merged.saleEndsAt &&
      merged.saleEndsAt <= merged.saleStartsAt
    ) {
      throw new BadRequestException({
        message: 'saleEndsAt must be after saleStartsAt',
        code: ErrorCode.ValidationFailed,
      });
    }
    const { optionValues, ...all } = dto;
    // Price fields judged unchanged are NOT written: otherwise a save by someone without pricing.update could put an
    // old price back over a change made since `before` was read (and leave no price audit entry).
    const rest = Object.fromEntries(
      Object.entries(all).filter(
        ([k, v]) =>
          !(PRICE_FIELDS as readonly string[]).includes(k) ||
          !samePriceValue(
            v as number | Date | null | undefined,
            before[k as (typeof PRICE_FIELDS)[number]],
          ),
      ),
    ) as typeof all;
    const after = await this.prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...rest,
        ...(optionValues !== undefined
          ? { optionValues: optionValues ?? undefined }
          : {}),
      },
    });
    if (touchesPrice) {
      await this.audit.record({
        action: AuditAction.PriceChanged,
        outcome: 'SUCCESS',
        actorId: actor.userId,
        ...ctx,
        resourceType: 'variant',
        resourceId: variantId,
        metadata: {
          sku: after.sku,
          from: priceSnapshot(before),
          to: priceSnapshot(after),
        },
      });
    }
    return after;
  }

  async deleteVariant(
    actor: AuthPrincipal,
    variantId: string,
    ctx: RequestContext,
  ) {
    const res = await this.prisma.productVariant.updateMany({
      where: { id: variantId, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    });
    if (res.count === 0) throw new NotFoundException('Variant not found');
    await this.audit.record({
      action: AuditAction.ProductUpdated,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'variant',
      resourceId: variantId,
      metadata: { change: 'delete' },
    });
  }

  // ----------------------------------------------------------------------------------- images

  async uploadImage(
    actor: AuthPrincipal,
    productId: string,
    file: { buffer: Buffer; size: number } | undefined,
    meta: { altText?: string | undefined; variantId?: string | undefined },
    ctx: RequestContext,
  ) {
    await this.requireProduct(productId);
    if (!file || file.size === 0)
      throw new BadRequestException({
        message: 'An image file is required (field "file")',
        code: ErrorCode.ValidationFailed,
      });
    if (file.size > MAX_IMAGE_BYTES)
      throw new BadRequestException({
        message: 'Images must be 5 MB or smaller',
        code: ErrorCode.PayloadTooLarge,
      });
    const type = detectImageType(file.buffer);
    if (!type)
      throw new BadRequestException({
        message: 'Only JPEG, PNG or WebP images are accepted',
        code: ErrorCode.UnsupportedMediaType,
      });
    if (
      meta.variantId &&
      !(await this.prisma.productVariant.findFirst({
        where: { id: meta.variantId, productId },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException({
        message: 'Variant does not belong to this product',
        code: ErrorCode.ValidationFailed,
      });
    }
    const count = await this.prisma.productImage.count({
      where: { productId },
    });
    if (count >= MAX_IMAGES_PER_PRODUCT)
      throw new ConflictException({
        message: `A product can have up to ${MAX_IMAGES_PER_PRODUCT} images`,
        code: ErrorCode.Conflict,
      });

    // Re-encoded before storing: no EXIF/GPS (staff photos taken on phones) or hidden payload is ever published.
    let clean: Buffer;
    try {
      clean = await reencodeImage(file.buffer, type);
    } catch (err) {
      if (err instanceof ImageRejected)
        throw new BadRequestException({
          message:
            'The image could not be read (damaged, or too large in pixels)',
          code: ErrorCode.UnsupportedMediaType,
        });
      throw err;
    }
    const storageKey = `${randomUUID()}.${type.ext}`; // never derived from the client's filename
    await this.storage.put(storageKey, clean, type.mime);
    const image = await this.prisma.productImage.create({
      data: {
        productId,
        variantId: meta.variantId ?? null,
        storageKey,
        mimeType: type.mime,
        sizeBytes: clean.length,
        altText: meta.altText ? stripTags(meta.altText) : null,
        position: count,
      },
    });
    await this.audit.record({
      action: AuditAction.ProductImageUploaded,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'product',
      resourceId: productId,
      metadata: { imageId: image.id, mime: type.mime, bytes: clean.length },
    });
    return {
      id: image.id,
      url: this.query.imageUrl(storageKey),
      mimeType: type.mime,
      sizeBytes: clean.length,
      altText: image.altText,
      position: image.position,
    };
  }

  /**
   * Alt text, gallery order and variant link of one image. Moving an image to `position` renumbers the product's
   * images 0..n-1 in one transaction, so the order is always a clean sequence (no ties, no gaps).
   */
  async updateImage(
    actor: AuthPrincipal,
    imageId: string,
    dto: {
      altText?: string | null | undefined;
      position?: number | undefined;
      variantId?: string | null | undefined;
    },
    ctx: RequestContext,
  ) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });
    if (!image) throw new NotFoundException('Image not found');
    if (
      dto.variantId &&
      !(await this.prisma.productVariant.findFirst({
        where: {
          id: dto.variantId,
          productId: image.productId,
          deletedAt: null,
        },
        select: { id: true },
      }))
    )
      throw new BadRequestException({
        message: 'Variant does not belong to this product',
        code: ErrorCode.ValidationFailed,
      });
    await this.prisma.$transaction(async (tx) => {
      // Lock ALL the product's images FIRST, always in id order: two edits of the same gallery queue up instead of
      // each holding one row and waiting for the other's (deadlock).
      const rows = await tx.$queryRaw<
        { id: string; position: number; created_at: Date }[]
      >`
        SELECT id, position, created_at FROM product_images WHERE product_id = ${image.productId}::uuid
        ORDER BY id FOR UPDATE`;
      await tx.productImage.update({
        where: { id: imageId },
        data: {
          ...(dto.altText !== undefined
            ? { altText: dto.altText ? stripTags(dto.altText) : null }
            : {}),
          ...(dto.variantId !== undefined ? { variantId: dto.variantId } : {}),
        },
      });
      if (dto.position === undefined) return;
      const order = [...rows]
        .sort(
          (a, b) =>
            a.position - b.position ||
            a.created_at.getTime() - b.created_at.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map((r) => r.id)
        .filter((id) => id !== imageId);
      order.splice(Math.min(dto.position, order.length), 0, imageId);
      for (const [position, id] of order.entries())
        await tx.productImage.update({ where: { id }, data: { position } });
    });
    await this.audit.record({
      action: AuditAction.ProductImageUpdated,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'product',
      resourceId: image.productId,
      metadata: { imageId, fields: Object.keys(dto) },
    });
    return this.getProduct(image.productId);
  }

  async deleteImage(
    actor: AuthPrincipal,
    imageId: string,
    ctx: RequestContext,
  ) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });
    if (!image) throw new NotFoundException('Image not found');
    // The row goes first (the image disappears from every page at once) and the deletion is audited; the stored file
    // is removed afterwards. If that fails, the file is orphaned but unreachable (/media serves registered keys only):
    // it is logged for clean-up instead of failing a deletion that already happened.
    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.audit.record({
      action: AuditAction.ProductImageDeleted,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'product',
      resourceId: image.productId,
      metadata: { imageId },
    });
    await this.storage
      .delete(image.storageKey)
      .catch((err: unknown) =>
        this.logger.error(
          { imageId, err: (err as Error).name },
          'Stored image file could not be deleted (orphaned object)',
        ),
      );
  }

  // ------------------------------------------------------------------------------------ reads

  async listProducts(
    q: PaginationInput & {
      q?: string | undefined;
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | undefined;
      ids?: string | undefined;
    },
  ) {
    const ids = q.ids?.toLowerCase().split(',');
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(ids ? { id: { in: ids } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              {
                variants: {
                  some: { sku: { contains: q.q, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          updatedAt: true,
          _count: { select: { variants: true, images: true } },
          categories: { select: { category: { select: { name: true } } } },
          variants: {
            where: { deletedAt: null, isActive: true },
            select: {
              id: true,
              priceMinor: true,
              salePriceMinor: true,
              saleStartsAt: true,
              saleEndsAt: true,
            },
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    // Same price rule as the storefront (effectivePrice) and stock only through InventoryService.
    const stock = await this.inventory.availability(
      items.flatMap((p) => p.variants.map((v) => v.id)),
    );
    const now = new Date();
    return paginated(
      items.map(({ variants, categories, ...p }) => {
        const prices = variants.map((v) => effectivePrice(v, now));
        const units = variants.map((v) => stock.get(v.id));
        return {
          ...p,
          categories: categories.map((c) => c.category.name).sort(),
          /** Current customer price across the live (active) variants; null when none is on sale to customers. */
          price:
            prices.length === 0
              ? null
              : {
                  minMinor: Math.min(...prices.map((x) => x.unitPriceMinor)),
                  maxMinor: Math.max(...prices.map((x) => x.unitPriceMinor)),
                  onSale: prices.some((x) => x.onSale),
                },
          /** Sellable units (on hand minus reserved) over live variants, and whether any is at/below its threshold. */
          stock: {
            available: units.reduce((n, u) => n + (u?.available ?? 0), 0),
            lowStock: units.some((u) => u?.lowStock ?? false),
          },
        };
      }),
      total,
      q,
    );
  }

  async getProduct(id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        brand: true,
        categories: {
          include: {
            category: { select: { id: true, name: true, slug: true } },
          },
        },
        tags: { include: { tag: true } },
        attributes: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
        variants: { where: { deletedAt: null }, orderBy: { position: 'asc' } },
      },
    });
    if (!p) throw new NotFoundException('Product not found');
    const stock = await this.inventory.availability(
      p.variants.map((v) => v.id),
    );
    return {
      ...p,
      categories: p.categories.map((c) => c.category),
      tags: p.tags.map((t) => t.tag.name),
      images: p.images.map((i) => ({
        id: i.id,
        url: this.query.imageUrl(i.storageKey),
        altText: i.altText,
        position: i.position,
        variantId: i.variantId,
      })),
      variants: p.variants.map((v) => ({
        ...v,
        available: stock.get(v.id)?.available ?? 0,
      })),
    };
  }

  // ---------------------------------------------------------------------------------- helpers

  private async requireProduct(id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, publishedAt: true },
    });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  private assertPricingPermission(
    actor: AuthPrincipal,
    _variants: readonly VariantDto[],
  ) {
    if (!actor.permissions.has(Permission.PricingUpdate)) {
      throw new ForbiddenException({
        message: 'Setting prices requires the pricing.update permission',
        code: ErrorCode.Forbidden,
      });
    }
  }

  private async assertRefs(
    tx: Tx,
    brandId: string | null,
    categoryIds: readonly string[],
  ) {
    if (
      brandId &&
      !(await tx.brand.findUnique({
        where: { id: brandId },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException({
        message: 'Brand not found',
        code: ErrorCode.ValidationFailed,
      });
    }
    if (categoryIds.length > 0) {
      const found = await tx.category.count({
        where: { id: { in: [...new Set(categoryIds)] } },
      });
      if (found !== new Set(categoryIds).size)
        throw new BadRequestException({
          message: 'One or more categories do not exist',
          code: ErrorCode.ValidationFailed,
        });
    }
  }

  private async setTags(tx: Tx, productId: string, tags: readonly string[]) {
    const names = [
      ...new Set(tags.map((t) => stripTags(t).toLowerCase()).filter(Boolean)),
    ];
    await tx.productTag.deleteMany({ where: { productId } });
    for (const name of names) {
      const tag = await tx.tag.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      await tx.productTag.create({ data: { productId, tagId: tag.id } });
    }
  }

  private async insertVariant(
    tx: Tx,
    productId: string,
    v: VariantDto,
    position: number,
  ) {
    const variant = await tx.productVariant.create({
      data: {
        productId,
        sku: v.sku,
        name: v.name ?? null,
        priceMinor: v.priceMinor,
        salePriceMinor: v.salePriceMinor ?? null,
        saleStartsAt: v.saleStartsAt ?? null,
        saleEndsAt: v.saleEndsAt ?? null,
        isActive: v.isActive ?? true,
        position: v.position ?? position,
        weightGrams: v.weightGrams ?? null,
        ...(v.optionValues ? { optionValues: v.optionValues } : {}),
      },
    });
    await this.inventory.ensureStockRecord(tx, variant.id);
    return variant;
  }
}

/** Equal price-field values: numbers, null, or dates compared by instant. */
function samePriceValue(
  a: number | Date | null | undefined,
  b: number | Date | null,
): boolean {
  if (a instanceof Date || b instanceof Date)
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  return (a ?? null) === b;
}

function priceSnapshot(v: {
  priceMinor: number;
  salePriceMinor: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}) {
  return {
    priceMinor: v.priceMinor,
    salePriceMinor: v.salePriceMinor,
    saleStartsAt: v.saleStartsAt,
    saleEndsAt: v.saleEndsAt,
  };
}
