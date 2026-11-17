import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type {
  InventoryMovementType,
  Prisma,
} from '../../generated/prisma/client.js';
import {
  InsufficientStockException,
  ReservationExpiredException,
  ReservationNotFoundException,
} from './inventory.errors.js';

type Tx = Prisma.TransactionClient;

export interface ReservationLine {
  variantId: string;
  quantity: number;
}

export interface ReservationRef {
  referenceType: string;
  referenceId: string;
}

interface StockRow {
  id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  low_stock_threshold: number;
}

/**
 * PostgreSQL is the single source of truth for stock. Every mutation is ONE conditional UPDATE whose WHERE clause
 * re-checks availability under the row lock, so concurrent checkouts cannot oversell; table CHECK constraints are
 * the final backstop. Each change appends to the immutable inventory_movements ledger in the same transaction.
 *
 * Lifecycle: AVAILABLE -> RESERVED -> COMMITTED, or RESERVED -> RELEASED / EXPIRED.
 * `*InTx` variants join the caller's transaction (checkout, payment capture) so stock and money commit atomically;
 * the plain variants open their own transaction.
 */
export interface AdjustInput {
  variantId: string;
  warehouseId?: string;
  delta: number;
  reason: string;
  actorId: string;
  type: 'RECEIPT' | 'ADJUSTMENT' | 'RETURN';
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async defaultWarehouseId(
    tx: Tx | PrismaService = this.prisma,
  ): Promise<string> {
    const w = await tx.warehouse.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true },
    });
    if (!w)
      throw new Error('No default warehouse configured: run the seed command');
    return w.id;
  }

  /** Creates the (zero) stock record for a new variant in the default warehouse. Idempotent. */
  async ensureStockRecord(tx: Tx, variantId: string): Promise<void> {
    const warehouseId = await this.defaultWarehouseId(tx);
    await tx.inventory.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      update: {},
      create: { variantId, warehouseId },
    });
  }

  /** Sellable units per variant across active warehouses (on_hand - reserved). Missing variants map to 0. */
  async availability(
    variantIds: readonly string[],
    // Pass the transaction when called from inside one: asking the shared client for a SECOND connection while a
    // transaction holds the first can deadlock the pool under load (see test/commerce/pool-starvation.e2e-spec.ts).
    db: Tx | PrismaService = this.prisma,
  ): Promise<Map<string, { available: number; lowStock: boolean }>> {
    const result = new Map<string, { available: number; lowStock: boolean }>();
    if (variantIds.length === 0) return result;
    const rows = await db.$queryRaw<
      { variant_id: string; available: number; threshold: number }[]
    >`
      SELECT i.variant_id, SUM(i.on_hand - i.reserved)::int AS available, MAX(i.low_stock_threshold)::int AS threshold
      FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
      WHERE w.is_active AND i.variant_id = ANY(${[...variantIds]}::uuid[])
      GROUP BY i.variant_id`;
    for (const id of variantIds)
      result.set(id, { available: 0, lowStock: false });
    for (const r of rows)
      result.set(r.variant_id, {
        available: r.available,
        lowStock: r.available > 0 && r.available <= r.threshold,
      });
    return result;
  }

  // ------------------------------------------------------------------------------- adjustments

  async adjust(input: AdjustInput) {
    return this.prisma.$transaction((tx) => this.adjustInTx(tx, input));
  }

  /** The single stock-change path: conditional UPDATE + ledger row. Joins the caller's transaction. */
  async adjustInTx(tx: Tx, input: AdjustInput) {
    if (!Number.isSafeInteger(input.delta) || input.delta === 0)
      throw new RangeError('delta must be a non-zero integer');
    const warehouseId =
      input.warehouseId ?? (await this.defaultWarehouseId(tx));
    const exists = await tx.inventory.findUnique({
      where: {
        variantId_warehouseId: { variantId: input.variantId, warehouseId },
      },
      select: { id: true },
    });
    if (!exists)
      throw new NotFoundException(
        'No stock record for this variant and warehouse',
      );
    // Stock may never drop below what is already promised to customers (reserved).
    const [row] = await tx.$queryRaw<StockRow[]>`
      UPDATE inventory SET on_hand = on_hand + ${input.delta}, updated_at = now()
      WHERE variant_id = ${input.variantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND on_hand + ${input.delta} >= reserved
      RETURNING id, warehouse_id, on_hand, reserved, low_stock_threshold`;
    if (!row)
      throw new ConflictException({
        message:
          'Adjustment would take stock below the quantity already reserved',
        code: ErrorCode.Conflict,
      });
    await this.recordMovement(
      tx,
      input.type,
      input.variantId,
      row,
      input.delta,
      0,
      { reason: input.reason, actorId: input.actorId },
    );
    await this.maybeLowStock(tx, input.variantId, row, input.delta);
    return {
      variantId: input.variantId,
      warehouseId,
      onHand: row.on_hand,
      reserved: row.reserved,
      available: row.on_hand - row.reserved,
    };
  }

  /** Puts goods back on the shelf (cancelled paid order, accepted return). Joins the caller's transaction. */
  async restockInTx(
    tx: Tx,
    variantId: string,
    quantity: number,
    ref: ReservationRef,
    reason: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new RangeError('quantity must be a positive integer');
    const warehouseId = await this.defaultWarehouseId(tx);
    const [row] = await tx.$queryRaw<StockRow[]>`
      UPDATE inventory SET on_hand = on_hand + ${quantity}, updated_at = now()
      WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
      RETURNING id, warehouse_id, on_hand, reserved, low_stock_threshold`;
    if (!row) throw new NotFoundException('No stock record for this variant');
    await this.recordMovement(tx, 'RETURN', variantId, row, quantity, 0, {
      reason,
      referenceType: ref.referenceType,
      referenceId: ref.referenceId,
    });
  }

  // ------------------------------------------------------------------------------ reservations

  /** Standalone reservation in its own transaction. Checkout uses reserveInTx. */
  reserve(
    ref: ReservationRef,
    lines: readonly ReservationLine[],
    ttlSeconds: number,
  ) {
    return this.prisma.$transaction((tx) =>
      this.reserveInTx(tx, ref, lines, ttlSeconds),
    );
  }

  /**
   * All-or-nothing reservation for a reference (e.g. a checkout). Idempotent: repeating the call for the same
   * reference returns the existing reservation instead of reserving twice.
   */
  async reserveInTx(
    tx: Tx,
    ref: ReservationRef,
    lines: readonly ReservationLine[],
    ttlSeconds: number,
  ) {
    const merged = mergeLines(lines);
    const existing = await tx.inventoryReservation.findMany({
      where: { ...ref, status: { in: ['RESERVED', 'COMMITTED'] } },
    });
    if (existing.length > 0) {
      if (!sameLines(existing, merged))
        throw new ConflictException({
          message: 'This reference already holds a different reservation',
          code: ErrorCode.Conflict,
        });
      return existing;
    }
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const created = [];
    // Sorted lock order prevents deadlocks between concurrent multi-item checkouts.
    for (const line of merged) {
      const [row] = await tx.$queryRaw<StockRow[]>`
        UPDATE inventory i SET reserved = i.reserved + ${line.quantity}, updated_at = now()
        WHERE i.id = (
            SELECT i2.id FROM inventory i2 JOIN warehouses w2 ON w2.id = i2.warehouse_id
            WHERE i2.variant_id = ${line.variantId}::uuid AND w2.is_active AND i2.on_hand - i2.reserved >= ${line.quantity}
            ORDER BY w2.is_default DESC, (i2.on_hand - i2.reserved) DESC
            LIMIT 1)
          AND i.on_hand - i.reserved >= ${line.quantity}
        RETURNING i.id, i.warehouse_id, i.on_hand, i.reserved, i.low_stock_threshold`;
      if (!row) throw new InsufficientStockException(line.variantId); // rolls back every line reserved so far
      created.push(
        await tx.inventoryReservation.create({
          data: {
            ...ref,
            variantId: line.variantId,
            warehouseId: row.warehouse_id,
            quantity: line.quantity,
            expiresAt,
          },
        }),
      );
      await this.recordMovement(
        tx,
        'RESERVE',
        line.variantId,
        row,
        0,
        line.quantity,
        { referenceType: ref.referenceType, referenceId: ref.referenceId },
      );
      await this.maybeLowStock(tx, line.variantId, row, -line.quantity);
    }
    return created;
  }

  commit(
    ref: ReservationRef,
    expected?: readonly ReservationLine[],
  ): Promise<void> {
    return this.prisma.$transaction((tx) => this.commitInTx(tx, ref, expected));
  }

  /** RESERVED -> COMMITTED (stock leaves the building). An expired reservation can NEVER be committed. */
  async commitInTx(
    tx: Tx,
    ref: ReservationRef,
    expected?: readonly ReservationLine[],
  ): Promise<void> {
    const live = await tx.inventoryReservation.findMany({
      where: { ...ref, status: 'RESERVED' },
      orderBy: { variantId: 'asc' },
    });
    if (live.length === 0) {
      if (
        (await tx.inventoryReservation.count({
          where: { ...ref, status: 'COMMITTED' },
        })) > 0
      )
        return; // idempotent repeat
      if (
        (await tx.inventoryReservation.count({
          where: { ...ref, status: { in: ['EXPIRED', 'RELEASED'] } },
        })) > 0
      )
        throw new ReservationExpiredException();
      throw new ReservationNotFoundException();
    }
    const now = new Date();
    // Validate EVERYTHING before changing anything: a commit is all-or-nothing. If any hold lapsed, or the holds do not
    // cover the whole order the caller expects, nothing is committed (no partial shipment of stock).
    if (live.some((r) => r.expiresAt <= now))
      throw new ReservationExpiredException();
    if (expected && !sameLines(live, mergeLines(expected)))
      throw new ReservationExpiredException();
    for (const r of live) {
      const claimed = await tx.inventoryReservation.updateMany({
        where: { id: r.id, status: 'RESERVED', expiresAt: { gt: now } },
        data: { status: 'COMMITTED', resolvedAt: now },
      });
      if (claimed.count !== 1) throw new ReservationExpiredException(); // the whole commit rolls back
      const [row] = await tx.$queryRaw<StockRow[]>`
        UPDATE inventory SET on_hand = on_hand - ${r.quantity}, reserved = reserved - ${r.quantity}, updated_at = now()
        WHERE variant_id = ${r.variantId}::uuid AND warehouse_id = ${r.warehouseId}::uuid
        RETURNING id, warehouse_id, on_hand, reserved, low_stock_threshold`;
      await this.recordMovement(
        tx,
        'COMMIT',
        r.variantId,
        row!,
        -r.quantity,
        -r.quantity,
        { referenceType: ref.referenceType, referenceId: ref.referenceId },
      );
    }
  }

  release(ref: ReservationRef, reason: string): Promise<number> {
    return this.prisma.$transaction((tx) => this.releaseInTx(tx, ref, reason));
  }

  /** RESERVED -> RELEASED (cancelled checkout, failed payment). Idempotent. */
  async releaseInTx(
    tx: Tx,
    ref: ReservationRef,
    reason: string,
  ): Promise<number> {
    const live = await tx.inventoryReservation.findMany({
      where: { ...ref, status: 'RESERVED' },
      orderBy: { variantId: 'asc' },
    });
    let released = 0;
    for (const r of live)
      released += await this.returnToStock(
        tx,
        r,
        'RELEASED',
        'RELEASE',
        reason,
      );
    return released;
  }

  /** The lines a reference holds right now (any non-released state): used to restock a cancelled paid order. */
  /**
   * Returns the goods of a COMMITTED reservation to the shelf, exactly once. The reservation is flipped to RELEASED in the
   * same statement that selects it, so a repeat (a second cancel, a retry after a crash) finds nothing left to restock.
   */
  async restockCommittedInTx(
    tx: Tx,
    ref: ReservationRef,
    reason: string,
  ): Promise<number> {
    const lines = await tx.$queryRaw<
      { variant_id: string; quantity: number }[]
    >`
      UPDATE inventory_reservations SET status = 'RELEASED'
      WHERE reference_type = ${ref.referenceType} AND reference_id = ${ref.referenceId} AND status = 'COMMITTED'
      RETURNING variant_id, quantity`;
    for (const l of lines)
      await this.restockInTx(tx, l.variant_id, l.quantity, ref, reason);
    return lines.length;
  }

  /** Sweeps reservations past their expiry. Safe to run on several instances at once (SKIP LOCKED). */
  async expireDue(limit = 200): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM inventory_reservations
        WHERE status = 'RESERVED' AND expires_at <= now()
        ORDER BY expires_at LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      let expired = 0;
      for (const { id } of due) {
        const r = await tx.inventoryReservation.findUniqueOrThrow({
          where: { id },
        });
        expired += await this.returnToStock(
          tx,
          r,
          'EXPIRED',
          'EXPIRE',
          'reservation expired',
        );
      }
      return expired;
    });
  }

  /** Consistency check: `reserved` must equal the sum of live reservations. Returns the mismatches (alert if any). */
  reconcile() {
    return this.prisma.$queryRaw<
      {
        variant_id: string;
        warehouse_id: string;
        reserved: number;
        live: number;
      }[]
    >`
      SELECT i.variant_id, i.warehouse_id, i.reserved,
             COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'RESERVED'), 0)::int AS live
      FROM inventory i
      LEFT JOIN inventory_reservations r ON r.variant_id = i.variant_id AND r.warehouse_id = i.warehouse_id
      GROUP BY i.id, i.variant_id, i.warehouse_id, i.reserved
      HAVING i.reserved <> COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'RESERVED'), 0)`;
  }

  // ---------------------------------------------------------------------------------- helpers

  private async returnToStock(
    tx: Tx,
    r: {
      id: string;
      variantId: string;
      warehouseId: string;
      quantity: number;
      referenceType: string;
      referenceId: string;
    },
    status: 'RELEASED' | 'EXPIRED',
    type: 'RELEASE' | 'EXPIRE',
    reason: string,
  ): Promise<number> {
    const claimed = await tx.inventoryReservation.updateMany({
      where: { id: r.id, status: 'RESERVED' },
      data: { status, resolvedAt: new Date() },
    });
    if (claimed.count !== 1) return 0;
    const [row] = await tx.$queryRaw<StockRow[]>`
      UPDATE inventory SET reserved = reserved - ${r.quantity}, updated_at = now()
      WHERE variant_id = ${r.variantId}::uuid AND warehouse_id = ${r.warehouseId}::uuid
      RETURNING id, warehouse_id, on_hand, reserved, low_stock_threshold`;
    await this.recordMovement(tx, type, r.variantId, row!, 0, -r.quantity, {
      reason,
      referenceType: r.referenceType,
      referenceId: r.referenceId,
    });
    return 1;
  }

  private recordMovement(
    tx: Tx,
    type: InventoryMovementType,
    variantId: string,
    row: StockRow,
    onHandDelta: number,
    reservedDelta: number,
    extra: {
      reason?: string;
      actorId?: string;
      referenceType?: string;
      referenceId?: string;
    },
  ) {
    return tx.inventoryMovement.create({
      data: {
        variantId,
        warehouseId: row.warehouse_id,
        type,
        onHandDelta,
        reservedDelta,
        onHandAfter: row.on_hand,
        reservedAfter: row.reserved,
        reason: extra.reason ?? null,
        actorId: extra.actorId ?? null,
        referenceType: extra.referenceType ?? null,
        referenceId: extra.referenceId ?? null,
      },
    });
  }

  /** Emits `inventory.low_stock` (transactional outbox) when availability crosses the threshold downwards. */
  private async maybeLowStock(
    tx: Tx,
    variantId: string,
    row: StockRow,
    availableDelta: number,
  ): Promise<void> {
    const after = row.on_hand - row.reserved;
    const before = after - availableDelta;
    if (before > row.low_stock_threshold && after <= row.low_stock_threshold) {
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'inventory',
          aggregateId: variantId,
          eventType: 'inventory.low_stock',
          payload: {
            variantId,
            warehouseId: row.warehouse_id,
            available: after,
            threshold: row.low_stock_threshold,
          },
        },
      });
      this.logger.log({ variantId, available: after }, 'Low stock');
    }
  }
}

export function mergeLines(
  lines: readonly ReservationLine[],
): ReservationLine[] {
  const map = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1)
      throw new RangeError('quantity must be a positive integer');
    map.set(l.variantId, (map.get(l.variantId) ?? 0) + l.quantity);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}

function sameLines(
  existing: { variantId: string; quantity: number }[],
  wanted: ReservationLine[],
): boolean {
  const a = mergeLines(existing);
  return (
    a.length === wanted.length &&
    a.every(
      (l, i) =>
        l.variantId === wanted[i]!.variantId &&
        l.quantity === wanted[i]!.quantity,
    )
  );
}
