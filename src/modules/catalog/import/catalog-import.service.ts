import { HttpException, Injectable, Logger } from '@nestjs/common';
import {
  sanitizeRichText,
  stripTags,
} from '../../../common/utils/sanitize-html.js';
import { slugify } from '../../../common/utils/slug.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../../audit/audit-actions.js';
import { AuditService } from '../../audit/audit.service.js';
import { InventoryService } from '../../inventory/inventory.service.js';
import type { ImportPlan, PlannedProduct } from './import-file.js';

type Tx = Prisma.TransactionClient;

export interface ImportOptions {
  /** false = report what WOULD happen and write nothing (the default of the CLI). */
  apply: boolean;
  /** Existing products (matched by slug) are updated; otherwise they are left alone and reported as skipped. */
  updateExisting: boolean;
  /** Honour `status: PUBLISHED` from the file. Otherwise everything new is imported as a DRAFT for review. */
  publish: boolean;
  /** Required when applying: stock receipts and the audit record are attributed to this staff user. */
  actorId: string | null;
}

export interface ImportReport {
  mode: 'DRY_RUN' | 'APPLIED';
  categories: { created: number; existing: number };
  brands: { created: number; existing: number };
  products: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  variants: { created: number; updated: number };
  failures: { product: string; reason: string }[];
}

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002';

/** A refusal written by the importer itself: safe to show as it is. */
class ImportRefusal extends Error {}

/**
 * Idempotent catalogue import. Everything in the file was validated up front (see parseImportFile), so a bad file
 * writes nothing. Each product is its own transaction: a failure is reported and skipped, and re-running the same file
 * picks up where it stopped. Stock is only ever set for NEW variants (through the inventory ledger) - an import can
 * never overwrite live stock.
 */
@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  async run(plan: ImportPlan, opts: ImportOptions): Promise<ImportReport> {
    if (opts.apply && !opts.actorId)
      throw new Error('An acting staff user is required to apply an import');
    const report: ImportReport = {
      mode: opts.apply ? 'APPLIED' : 'DRY_RUN',
      categories: { created: 0, existing: 0 },
      brands: { created: 0, existing: 0 },
      products: { created: 0, updated: 0, skipped: 0, failed: 0 },
      variants: { created: 0, updated: 0 },
      failures: [],
    };

    const categoryIds = await this.importCategories(plan, opts, report);
    const brandIds = await this.importBrands(plan, opts, report);

    for (const p of plan.products) {
      try {
        await this.importProduct(p, categoryIds, brandIds, opts, report);
      } catch (err) {
        report.products.failed += 1;
        report.failures.push({
          product: p.key ?? p.slug,
          reason: this.safeReason(err, p.key ?? p.slug),
        });
      }
    }

    if (opts.apply)
      await this.audit.record({
        action: AuditAction.CatalogImported,
        outcome: report.products.failed === 0 ? 'SUCCESS' : 'FAILURE',
        actorId: opts.actorId!,
        resourceType: 'catalog',
        metadata: {
          products: report.products,
          variants: report.variants,
          categories: report.categories,
          brands: report.brands,
          updateExisting: opts.updateExisting,
          publish: opts.publish,
        },
      });
    return report;
  }

  /**
   * The failure text shown in the report (the console sends it to a browser): our own messages and known database
   * refusals only; anything else is logged here and reported as an internal error (no SQL or framework text leaks).
   */
  private safeReason(err: unknown, product: string): string {
    if (isUnique(err)) return 'a slug or SKU already exists';
    if (err instanceof ImportRefusal || err instanceof HttpException)
      return err.message.slice(0, 200);
    const code = (err as { code?: unknown }).code;
    if (code === 'P2003') return 'it refers to something that does not exist';
    this.logger.error(
      { product, err: (err as Error).message },
      'catalogue import: product failed',
    );
    return 'internal error (details are in the server log)';
  }

  private async importCategories(
    plan: ImportPlan,
    opts: ImportOptions,
    report: ImportReport,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const c of plan.categories) {
      const existing = await this.prisma.category.findUnique({
        where: { slug: c.slug },
        select: { id: true },
      });
      if (existing) {
        ids.set(c.key, existing.id);
        report.categories.existing += 1;
        continue;
      }
      report.categories.created += 1;
      if (!opts.apply) {
        ids.set(c.key, `dry:${c.key}`);
        continue;
      }
      const created = await this.prisma.category.create({
        data: {
          name: stripTags(c.name),
          slug: c.slug,
          parentId: c.parentKey ? (ids.get(c.parentKey) ?? null) : null,
        },
        select: { id: true },
      });
      ids.set(c.key, created.id);
    }
    return ids;
  }

  private async importBrands(
    plan: ImportPlan,
    opts: ImportOptions,
    report: ImportReport,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    const names = new Map<string, string>(); // lower-case -> display name
    for (const p of plan.products)
      if (p.brand)
        names.set(stripTags(p.brand).toLowerCase(), stripTags(p.brand));
    for (const [lower, name] of names) {
      const existing = await this.prisma.brand.findFirst({
        where: {
          OR: [
            { name: { equals: name, mode: 'insensitive' } },
            { slug: slugify(name) },
          ],
        },
        select: { id: true },
      });
      if (existing) {
        ids.set(lower, existing.id);
        report.brands.existing += 1;
        continue;
      }
      report.brands.created += 1;
      if (!opts.apply) {
        ids.set(lower, `dry:${lower}`);
        continue;
      }
      const created = await this.prisma.brand.create({
        data: { name, slug: slugify(name) },
        select: { id: true },
      });
      ids.set(lower, created.id);
    }
    return ids;
  }

  private async importProduct(
    p: PlannedProduct,
    categoryIds: Map<string, string>,
    brandIds: Map<string, string>,
    opts: ImportOptions,
    report: ImportReport,
  ): Promise<void> {
    const existing = await this.prisma.product.findUnique({
      where: { slug: p.slug },
      select: { id: true },
    });
    const owners = await this.prisma.productVariant.findMany({
      where: { sku: { in: p.variants.map((v) => v.sku) } },
      select: { id: true, sku: true, productId: true },
    });
    const foreign = owners.find((o) => o.productId !== existing?.id);
    if (foreign)
      throw new ImportRefusal(
        `SKU "${foreign.sku}" already belongs to another product`,
      );

    if (existing && !opts.updateExisting) {
      report.products.skipped += 1;
      return;
    }

    const categories = p.categoryKeys.map((k) => categoryIds.get(k)!);
    const brandId = p.brand
      ? (brandIds.get(stripTags(p.brand).toLowerCase()) ?? null)
      : null;
    const skuToVariant = new Map(owners.map((o) => [o.sku, o.id]));
    const newVariants = p.variants.filter((v) => !skuToVariant.has(v.sku));
    const oldVariants = p.variants.filter((v) => skuToVariant.has(v.sku));

    if (!opts.apply) {
      report.products[existing ? 'updated' : 'created'] += 1;
      report.variants.created += newVariants.length;
      report.variants.updated += oldVariants.length;
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const publish = !existing && opts.publish && p.status === 'PUBLISHED';
      const common = {
        name: stripTags(p.name),
        summary: p.summary ? stripTags(p.summary) : null,
        descriptionHtml: sanitizeRichText(p.descriptionHtml ?? ''),
        brandId,
        gstRateBps: p.gstRateBps ?? 1800,
        hsnCode: p.hsnCode ?? null,
      };
      let productId: string;
      if (existing) {
        productId = existing.id;
        await tx.product.update({ where: { id: productId }, data: common });
        await tx.productCategory.deleteMany({ where: { productId } });
        await tx.productAttribute.deleteMany({ where: { productId } });
      } else {
        const created = await tx.product.create({
          data: {
            ...common,
            slug: p.slug,
            status: publish ? 'PUBLISHED' : 'DRAFT',
            publishedAt: publish ? new Date() : null,
          },
          select: { id: true },
        });
        productId = created.id;
      }
      await tx.productCategory.createMany({
        data: categories.map((categoryId) => ({ productId, categoryId })),
      });
      await tx.productAttribute.createMany({
        data: (p.attributes ?? []).map((a, position) => ({
          productId,
          name: stripTags(a.name),
          value: stripTags(a.value),
          position,
        })),
      });
      await this.setTags(tx, productId, p.tags ?? []);

      for (const v of oldVariants) {
        const id = skuToVariant.get(v.sku)!;
        const before = await tx.productVariant.findUniqueOrThrow({
          where: { id },
          select: { priceMinor: true, salePriceMinor: true },
        });
        await tx.productVariant.update({
          where: { id },
          data: {
            name: v.name ?? null,
            priceMinor: v.priceMinor,
            salePriceMinor: v.salePriceMinor ?? null,
            weightGrams: v.weightGrams ?? null,
          },
        });
        // A price changed by an import is audited like one changed in the editor (from/to), in the same transaction.
        if (
          before.priceMinor !== v.priceMinor ||
          before.salePriceMinor !== (v.salePriceMinor ?? null)
        )
          await this.audit.recordInTx(tx, {
            action: AuditAction.PriceChanged,
            outcome: 'SUCCESS',
            actorId: opts.actorId!,
            resourceType: 'variant',
            resourceId: id,
            metadata: {
              sku: v.sku,
              source: 'catalog-import',
              from: before,
              to: {
                priceMinor: v.priceMinor,
                salePriceMinor: v.salePriceMinor ?? null,
              },
            },
          });
      }
      for (const [i, v] of newVariants.entries()) {
        const variant = await tx.productVariant.create({
          data: {
            productId,
            sku: v.sku,
            name: v.name ?? null,
            priceMinor: v.priceMinor,
            salePriceMinor: v.salePriceMinor ?? null,
            weightGrams: v.weightGrams ?? null,
            position: oldVariants.length + i,
          },
          select: { id: true },
        });
        await this.inventory.ensureStockRecord(tx, variant.id);
        if (v.stock > 0)
          await this.inventory.adjustInTx(tx, {
            variantId: variant.id,
            delta: v.stock,
            type: 'RECEIPT',
            reason: 'Initial stock (catalogue import)',
            actorId: opts.actorId!,
          });
      }
    });
    report.products[existing ? 'updated' : 'created'] += 1;
    report.variants.created += newVariants.length;
    report.variants.updated += oldVariants.length;
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
}
