import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync, statSync } from 'node:fs';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { Permission } from '../modules/access/permissions.js';
import { AuthorizationService } from '../modules/access/authorization.service.js';
import { CatalogImportService } from '../modules/catalog/import/catalog-import.service.js';
import {
  IMPORT_LIMITS,
  parseImportFile,
} from '../modules/catalog/import/import-file.js';

const USAGE = `Usage: node dist/cli/import-catalog.js --file <catalog.json> [--apply --as <staff-email>] [--update-existing] [--publish]

  (default)          validate the file and print what WOULD happen; nothing is written
  --apply            write to the database (requires --as)
  --as <email>       the staff member the import (stock receipts, audit record) is attributed to;
                     must hold products.create and pricing.update
  --update-existing  update products that already exist (matched by slug); default is to leave them alone
  --publish          honour "status": "PUBLISHED" from the file; default imports everything as DRAFT
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const logger = new Logger('ImportCatalog');
  const path = arg('file');
  if (!path) {
    process.stderr.write(USAGE);
    return 2;
  }
  const apply = flag('apply');
  const email = arg('as');
  if (apply && !email) {
    process.stderr.write('--apply requires --as <staff-email>\n');
    return 2;
  }

  if (statSync(path).size > IMPORT_LIMITS.maxFileBytes) {
    process.stderr.write('File is larger than 20 MB\n');
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stderr.write('The file is not valid JSON\n');
    return 2;
  }
  const parsed = parseImportFile(raw);
  if (!parsed.ok) {
    process.stderr.write(
      `The file has ${parsed.issues.length} problem(s); nothing was imported:\n`,
    );
    for (const i of parsed.issues)
      process.stderr.write(`  - ${i.path}: ${i.message}\n`);
    return 1;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    let actorId: string | null = null;
    if (apply) {
      const user = await app.get(PrismaService).user.findUnique({
        where: { emailNormalized: email!.trim().toLowerCase() },
        select: { id: true },
      });
      const access = user
        ? await app.get(AuthorizationService).loadAccess(user.id)
        : null;
      // The same permissions the console import checks: publishing and stock receipts need their own.
      const receivesStock = parsed.plan.products.some((p) =>
        p.variants.some((v) => (v.stock ?? 0) > 0),
      );
      const needed = [
        Permission.ProductsCreate,
        Permission.PricingUpdate,
        ...(flag('publish') ? [Permission.ProductsPublish] : []),
        ...(flag('update-existing') ? [Permission.ProductsUpdate] : []),
        ...(receivesStock ? [Permission.InventoryAdjust] : []),
      ];
      const allowed =
        access?.status === 'ACTIVE' &&
        needed.every((p) => access.permissions.includes(p));
      if (!user || !allowed) {
        process.stderr.write(
          `--as must name an ACTIVE staff user with ${needed.join(', ')}\n`,
        );
        return 2;
      }
      actorId = user.id;
    }
    const report = await app.get(CatalogImportService).run(parsed.plan, {
      apply,
      updateExisting: flag('update-existing'),
      publish: flag('publish'),
      actorId,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!apply)
      logger.log('Dry run only. Re-run with --apply --as <email> to write.');
    return report.products.failed > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

process.exitCode = await main();
