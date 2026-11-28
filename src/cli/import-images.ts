import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AuthorizationService } from '../modules/access/authorization.service.js';
import { Permission } from '../modules/access/permissions.js';
import { CatalogAdminService } from '../modules/catalog/catalog-admin.service.js';
import {
  readNoFollow,
  resolveInside,
} from '../modules/catalog/import/image-paths.js';
import { reencodeImage } from '../modules/catalog/media/image-processing.js';
import { detectImageType } from '../modules/catalog/media/image-validation.js';

/**
 * Uploads product images from a LOCAL copy of OpenCart's image folder (no URL is ever fetched: no SSRF), through the
 * same validated path as the console upload (content sniffing, size limit, server-generated names, audit record).
 * Re-runnable: a product that already has all its images is skipped; one that was only partly uploaded is reported (finish
 * it in the console: uploading the list again would duplicate images). A product whose slug matches but whose SKUs do not
 * (made by hand before the migration) is never touched.
 */
const USAGE = `Usage: node dist/cli/import-images.js --manifest <images.json> --dir <opencart image folder> [--apply --as <staff-email>]

  images.json comes from convert:opencart; --dir is the folder that contains OpenCart's "catalog/" image folder.
  (default)   check every file and product, upload nothing
  --apply     upload (the staff member named by --as needs products.update)
`;

const manifestSchema = z
  .array(
    z
      .object({
        productSlug: z.string().min(1).max(160),
        /** The product's SKUs (from convert:opencart): a product with this slug but none of them is someone else's. */
        skus: z.array(z.string().min(1).max(64)).max(50).optional(),
        images: z
          .array(
            z
              .object({
                path: z.string().min(1).max(255),
                altText: z.string().max(200).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
  )
  .max(5_000);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const logger = new Logger('ImportImages');
  const manifestPath = arg('manifest');
  const dir = arg('dir');
  const apply = flag('apply');
  const email = arg('as');
  if (!manifestPath || !dir || (apply && !email)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const parsed = manifestSchema.safeParse(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  );
  if (!parsed.success) {
    process.stderr.write(
      `The manifest is not valid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}\n`,
    );
    return 2;
  }
  const root = realpathSync(dir);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    let actor: AuthPrincipal | null = null;
    if (apply) {
      const user = await prisma.user.findUnique({
        where: { emailNormalized: email!.trim().toLowerCase() },
        select: { id: true },
      });
      const access = user
        ? await app.get(AuthorizationService).loadAccess(user.id)
        : null;
      if (
        !user ||
        access?.status !== 'ACTIVE' ||
        !access.permissions.includes(Permission.ProductsUpdate)
      ) {
        process.stderr.write(
          '--as must name an ACTIVE staff user with products.update\n',
        );
        return 2;
      }
      actor = {
        userId: user.id,
        sessionId: 'cli',
        amr: ['cli'],
        authTime: Math.floor(Date.now() / 1000),
        roles: access.roles.map(({ name, rank }) => ({ name, rank })),
        permissions: new Set(access.permissions),
        maxRank: access.maxRank,
      };
    }
    const catalog = app.get(CatalogAdminService);
    const report = {
      products: 0,
      missingProducts: 0,
      skippedWithImages: 0,
      uploaded: 0,
      problems: [] as string[],
    };
    for (const entry of parsed.data) {
      const product = await prisma.product.findFirst({
        where: { slug: entry.productSlug, deletedAt: null },
        select: {
          id: true,
          _count: { select: { images: true } },
          variants: { select: { sku: true } },
        },
      });
      if (!product) {
        report.missingProducts += 1;
        report.problems.push(
          `${entry.productSlug}: no such product (import the catalogue first)`,
        );
        continue;
      }
      // a product made by hand before the migration can have the same slug: never put OpenCart images on it
      const own = new Set(product.variants.map((v) => v.sku.toUpperCase()));
      if (
        entry.skus?.length &&
        !entry.skus.some((sku) => own.has(sku.toUpperCase()))
      ) {
        report.problems.push(
          `${entry.productSlug}: this product has none of the SKUs ${entry.skus.join(', ')}: it is a different product, skipped`,
        );
        continue;
      }
      report.products += 1;
      if (product._count.images >= entry.images.length) {
        report.skippedWithImages += 1; // done (an earlier run, or images added in the console)
        continue;
      }
      if (product._count.images > 0) {
        // stopped half-way earlier: uploading the list again would duplicate the first images
        report.problems.push(
          `${entry.productSlug}: has ${product._count.images} of ${entry.images.length} images: add the rest in the console (Products → Images)`,
        );
        continue;
      }
      // Check EVERY image of the product first (path, content, a full decode and re-encode as the upload does), and
      // upload only when all pass: --apply never stops half-way through a product.
      const ready: { buffer: Buffer; altText?: string }[] = [];
      const before = report.problems.length;
      for (const img of entry.images) {
        const found = resolveInside(root, img.path);
        if ('error' in found) {
          report.problems.push(
            `${entry.productSlug}: ${img.path}: ${found.error}`,
          );
          continue;
        }
        let buffer: Buffer;
        try {
          buffer = readNoFollow(found.file);
        } catch {
          report.problems.push(
            `${entry.productSlug}: ${img.path}: could not be read`,
          );
          continue;
        }
        const type = detectImageType(buffer);
        if (!type) {
          report.problems.push(
            `${entry.productSlug}: ${img.path}: not a JPEG, PNG or WebP image`,
          );
          continue;
        }
        try {
          await reencodeImage(buffer, type);
        } catch {
          report.problems.push(
            `${entry.productSlug}: ${img.path}: the image could not be processed (damaged or too large)`,
          );
          continue;
        }
        ready.push({
          buffer,
          ...(img.altText ? { altText: img.altText } : {}),
        });
      }
      if (report.problems.length > before) {
        report.problems.push(
          `${entry.productSlug}: not uploaded (fix the files above, then run again)`,
        );
        continue;
      }
      if (!apply) continue;
      for (const img of ready) {
        try {
          await catalog.uploadImage(
            actor!,
            product.id,
            { buffer: img.buffer, size: img.buffer.length },
            img.altText ? { altText: img.altText } : {},
            { ip: null, userAgent: 'cli/import-images', correlationId: null },
          );
          report.uploaded += 1;
        } catch (err) {
          report.problems.push(
            `${entry.productSlug}: ${(err as Error).message}`,
          );
          break; // the rest would only repeat the failure; the product is reported as partly uploaded on re-run
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY_RUN', ...report }, null, 2)}\n`,
    );
    if (!apply)
      logger.log('Dry run only. Re-run with --apply --as <email> to upload.');
    return report.problems.length ? 1 : 0;
  } finally {
    await app.close();
  }
}

process.exitCode = await main();
