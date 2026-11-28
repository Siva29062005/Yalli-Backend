import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AuthorizationService } from '../modules/access/authorization.service.js';
import { Permission } from '../modules/access/permissions.js';
import { AuditAction } from '../modules/audit/audit-actions.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { parseStockSheet } from '../modules/inventory/stock-sheet.js';

/**
 * The go-live stock take (Phase 15): sets each SKU's on-hand quantity in the DEFAULT warehouse to the number in a
 * `sku,quantity` sheet (`stock.csv` from convert:opencart, exported again after the old store went into maintenance).
 * Every change goes through InventoryService (row locked, ledger row, never below what is reserved) and is audited.
 * Dry run by default: it lists what would change.
 */
const USAGE = `Usage: node dist/cli/set-stock.js --file <stock.csv> [--apply --as <staff-email>] [--reason <text>]
  (default)   show the changes, change nothing
  --apply     set the stock (the staff member named by --as needs inventory.adjust)
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const file = arg('file');
  const apply = process.argv.includes('--apply');
  const email = arg('as');
  const reason = (arg('reason') ?? 'opening stock at go-live').trim();
  if (!file || (apply && !email) || reason.length < 3 || reason.length > 200) {
    process.stderr.write(USAGE);
    return 2;
  }
  const sheet = parseStockSheet(readFileSync(file, 'utf8'));
  if (sheet.problems.length) {
    process.stderr.write(
      `The sheet has problems; nothing was changed:\n  ${sheet.problems.slice(0, 50).join('\n  ')}\n`,
    );
    return 1;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const inventory = app.get(InventoryService);
    let actorId: string | null = null;
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
        !access.permissions.includes(Permission.InventoryAdjust)
      ) {
        process.stderr.write(
          '--as must name an ACTIVE staff user with inventory.adjust\n',
        );
        return 2;
      }
      actorId = user.id;
    }
    const warehouseId = await inventory.defaultWarehouseId();
    const report = {
      mode: apply ? 'APPLIED' : 'DRY_RUN',
      rows: sheet.rows.length,
      changed: 0,
      unchanged: 0,
      problems: [] as string[],
      changes: [] as { sku: string; from: number; to: number }[],
    };
    for (const row of sheet.rows) {
      const variant = await prisma.productVariant.findFirst({
        where: { sku: { equals: row.sku, mode: 'insensitive' } },
        select: {
          id: true,
          sku: true,
          inventory: {
            where: { warehouseId },
            select: { onHand: true, reserved: true },
          },
        },
      });
      if (!variant) {
        report.problems.push(`${row.sku}: no such SKU`);
        continue;
      }
      const current = variant.inventory[0] ?? { onHand: 0, reserved: 0 };
      if (current.onHand === row.quantity) {
        report.unchanged += 1;
        continue;
      }
      if (row.quantity < current.reserved) {
        report.problems.push(
          `${variant.sku}: ${current.reserved} already reserved for orders, cannot set ${row.quantity}`,
        );
        continue;
      }
      report.changes.push({
        sku: variant.sku,
        from: current.onHand,
        to: row.quantity,
      });
      if (!apply) {
        report.changed += 1;
        continue;
      }
      try {
        const result = await prisma.$transaction((tx) =>
          inventory.setOnHandInTx(tx, {
            variantId: variant.id,
            warehouseId,
            onHand: row.quantity,
            reason,
            actorId: actorId!,
          }),
        );
        if (!result) {
          report.unchanged += 1;
          continue;
        }
        report.changed += 1;
        await app.get(AuditService).record({
          action: AuditAction.InventoryAdjusted,
          outcome: 'SUCCESS',
          actorId,
          ip: null,
          userAgent: 'cli/set-stock',
          correlationId: null,
          resourceType: 'variant',
          resourceId: variant.id,
          metadata: {
            sku: variant.sku,
            delta: result.delta,
            type: 'ADJUSTMENT',
            reason,
            onHandAfter: result.onHand,
          },
        });
      } catch (err) {
        report.problems.push(`${variant.sku}: ${(err as Error).message}`);
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!apply)
      new Logger('SetStock').log(
        'Dry run only. Re-run with --apply --as <email> to set the stock.',
      );
    return report.problems.length ? 1 : 0;
  } finally {
    await app.close();
  }
}

process.exitCode = await main();
