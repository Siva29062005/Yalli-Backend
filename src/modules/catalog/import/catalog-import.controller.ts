import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import type { AuthPrincipal } from '../../../common/auth/auth-principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
  RequireStepUp,
} from '../../../common/decorators/access.decorators.js';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';
import { EphemeralStore } from '../../../infrastructure/cache/ephemeral-store.js';
import { Permission } from '../../access/permissions.js';
import { CatalogImportService } from './catalog-import.service.js';
import { parseImportFile } from './import-file.js';

/** The console takes smaller files than the CLI (one HTTP request, behind load-balancer timeouts). */
export const CONSOLE_IMPORT_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  products: 500,
} as const;
const DRY_RUN_TTL_SECONDS = 30 * 60;

const optionsSchema = z
  .object({
    apply: z.enum(['true', 'false']).default('false'),
    updateExisting: z.enum(['true', 'false']).default('false'),
    publish: z.enum(['true', 'false']).default('false'),
  })
  .strict();

/**
 * Catalogue import in the staff console. The same rules as the CLI (`CatalogImportService`): the WHOLE file is validated
 * first (a bad file writes nothing), dry run by default, DRAFT unless publishing is asked for, existing products left
 * alone unless updating is asked for, stock only for new variants and only through the ledger.
 * In addition: APPLYING needs a dry run of the very same file (same bytes, same options) by the same person in the last
 * 30 minutes; publishing needs products.publish; a file that receives stock needs inventory.adjust.
 */
@ApiTags('admin-catalog-import')
@Controller('admin/catalog/import')
@RequireStepUp(900)
@RequirePermissions(Permission.ProductsCreate, Permission.PricingUpdate)
@RateLimit({
  name: 'catalog-import',
  limit: 30,
  windowSeconds: 3_600,
  key: 'principal',
})
export class CatalogImportController {
  constructor(
    private readonly importer: CatalogImportService,
    private readonly store: EphemeralStore,
  ) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: CONSOLE_IMPORT_LIMITS.maxFileBytes,
        files: 1,
        fields: 3,
        parts: 4,
      },
    }),
  )
  async run(
    @CurrentPrincipal() a: AuthPrincipal,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body({ schema: optionsSchema }) opts: z.infer<typeof optionsSchema>,
  ) {
    if (!file || file.size === 0)
      throw new BadRequestException({
        message: 'Choose the catalogue file (JSON) to import',
        code: ErrorCode.ValidationFailed,
      });
    let raw: unknown;
    try {
      raw = JSON.parse(file.buffer.toString('utf8'));
    } catch {
      throw new BadRequestException({
        message: 'The file is not valid JSON',
        code: ErrorCode.ValidationFailed,
      });
    }
    const parsed = parseImportFile(raw);
    if (!parsed.ok)
      throw new BadRequestException({
        message: `The file has ${parsed.issues.length} problem(s); nothing was imported`,
        code: ErrorCode.ValidationFailed,
        // `issues` reach the client as path + message only (the exception filter never echoes values)
        issues: parsed.issues
          .slice(0, 50)
          .map((i) => ({ path: i.path.split('.'), message: i.message })),
      });
    if (parsed.plan.products.length > CONSOLE_IMPORT_LIMITS.products)
      throw new BadRequestException({
        message: `The console imports up to ${CONSOLE_IMPORT_LIMITS.products} products at a time; split the file or use the import command`,
        code: ErrorCode.ValidationFailed,
      });

    const apply = opts.apply === 'true';
    const publish = opts.publish === 'true';
    const updateExisting = opts.updateExisting === 'true';
    // Updating existing (possibly live) products is editing them: products.update, like the editor.
    if (updateExisting && !a.permissions.has(Permission.ProductsUpdate))
      throw new ForbiddenException({
        message:
          'Updating existing products needs the products.update permission',
        code: ErrorCode.Forbidden,
      });
    if (publish && !a.permissions.has(Permission.ProductsPublish))
      throw new ForbiddenException({
        message:
          'Publishing during an import needs the products.publish permission',
        code: ErrorCode.Forbidden,
      });
    const receivesStock = parsed.plan.products.some((p) =>
      p.variants.some((v) => (v.stock ?? 0) > 0),
    );
    if (receivesStock && !a.permissions.has(Permission.InventoryAdjust))
      throw new ForbiddenException({
        message:
          'This file sets stock: that needs the inventory.adjust permission',
        code: ErrorCode.Forbidden,
      });

    // The dry run is remembered by (person, file bytes, options); applying anything else is refused.
    const digest = createHash('sha256')
      .update(file.buffer)
      .update(`|${updateExisting}|${publish}`)
      .digest('hex');
    const key = `catalog-import:dry-run:${a.userId}:${digest}`;
    if (apply && !(await this.store.get(key)))
      throw new BadRequestException({
        message:
          'Run a dry run of this exact file (and options) first, then confirm within 30 minutes',
        code: 'IMPORT_DRY_RUN_REQUIRED',
      });
    // One confirmation per dry run: the atomic counter lets only the FIRST of two simultaneous "Import now" clicks run.
    if (
      apply &&
      (await this.store.incr(`${key}:applied`, DRY_RUN_TTL_SECONDS)).count > 1
    )
      throw new BadRequestException({
        message:
          'This import is already running or was just applied; check the products, or run a new dry run',
        code: 'IMPORT_DRY_RUN_REQUIRED',
      });

    const report = await this.importer.run(parsed.plan, {
      apply,
      updateExisting,
      publish,
      actorId: apply ? a.userId : null,
    });
    if (apply) await this.store.del(key);
    else {
      await this.store.set(key, '1', DRY_RUN_TTL_SECONDS);
      await this.store.del(`${key}:applied`); // a fresh dry run may be confirmed once again
    }
    return report;
  }
}
