import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import {
  CatalogFixture,
  Scenario,
  authed,
  createTestApp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let fx: CatalogFixture;
let inv: InventoryService;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  fx = new CatalogFixture(ctx);
  inv = ctx.app.get(InventoryService);
});
afterAll(() => ctx.close());

const ref = () => ({
  referenceType: 'TEST_CHECKOUT',
  referenceId: randomUUID(),
});
const stockOf = (variantId: string) =>
  ctx.prisma.inventory.findFirstOrThrow({ where: { variantId } });

describe('go-live stock take (setOnHandInTx, npm run set:stock)', () => {
  it('sets the on-hand quantity through the ledger, does nothing when it already matches, never below what is reserved', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const actor = await s.staff('INVENTORY_MANAGER');
    const set = (onHand: number) =>
      ctx.prisma.$transaction((tx) =>
        inv.setOnHandInTx(tx, {
          variantId: variant.id,
          onHand,
          reason: 'opening stock at go-live',
          actorId: actor.userId,
        }),
      );
    expect(await set(25)).toMatchObject({ delta: 15, onHand: 25 });
    expect(await set(25)).toBeNull();
    expect(await set(4)).toMatchObject({ delta: -21, onHand: 4 });
    const ledger = await ctx.prisma.inventoryMovement.findMany({
      where: { variantId: variant.id, reason: 'opening stock at go-live' },
      orderBy: { createdAt: 'asc' },
    });
    expect(ledger.map((m) => m.onHandDelta)).toEqual([15, -21]);
    await inv.reserve(ref(), [{ variantId: variant.id, quantity: 3 }], 900);
    await expect(set(2)).rejects.toThrow(/below the quantity already reserved/);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 4, reserved: 3 });
    await expect(set(-1)).rejects.toThrow(RangeError);
  });
});

describe('restocking committed goods', () => {
  it('is single-shot: repeating it (a retry, a second cancel) cannot credit the shelf twice', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 4 }], 900);
    await inv.commit(r);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 6, reserved: 0 });

    const restock = () =>
      ctx.prisma.$transaction((tx) =>
        inv.restockCommittedInTx(tx, r, 'test cancel'),
      );
    expect(await restock()).toBe(1);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10 });
    expect(await restock()).toBe(0); // nothing left to restock
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10 });
    // concurrent attempts: exactly one wins
    const r2 = ref();
    await inv.reserve(r2, [{ variantId: variant.id, quantity: 2 }], 900);
    await inv.commit(r2);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx.prisma.$transaction((tx) =>
          inv.restockCommittedInTx(tx, r2, 'race'),
        ),
      ),
    );
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 10 });
  });

  it('never restocks goods that were only reserved (not paid for) or that belong to another reference', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 2 }], 900);
    expect(
      await ctx.prisma.$transaction((tx) =>
        inv.restockCommittedInTx(tx, r, 'x'),
      ),
    ).toBe(0);
    expect(
      await ctx.prisma.$transaction((tx) =>
        inv.restockCommittedInTx(tx, ref(), 'x'),
      ),
    ).toBe(0);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 5, reserved: 2 });
  });
});

describe('reservations', () => {
  it('reserves, then commits: on-hand drops, reserved returns to zero, every step is in the ledger', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 3 }], 900);
    expect(await stockOf(variant.id)).toMatchObject({
      onHand: 10,
      reserved: 3,
    });
    await inv.commit(r);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 7, reserved: 0 });
    const ledger = await ctx.prisma.inventoryMovement.findMany({
      where: { variantId: variant.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      ledger.map((m) => [
        m.type,
        m.onHandDelta,
        m.reservedDelta,
        m.onHandAfter,
        m.reservedAfter,
      ]),
    ).toEqual([
      ['RESERVE', 0, 3, 10, 3],
      ['COMMIT', -3, -3, 7, 0],
    ]);
    await inv.commit(r); // idempotent repeat changes nothing
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 7, reserved: 0 });
  });

  it('is all-or-nothing: if any line lacks stock, nothing is reserved', async () => {
    const a = await fx.product({ stock: 5 });
    const b = await fx.product({ stock: 1 });
    await expect(
      inv.reserve(
        ref(),
        [
          { variantId: a.variant.id, quantity: 2 },
          { variantId: b.variant.id, quantity: 2 },
        ],
        900,
      ),
    ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK' } });
    expect(await stockOf(a.variant.id)).toMatchObject({ reserved: 0 });
    expect(await stockOf(b.variant.id)).toMatchObject({ reserved: 0 });
  });

  it('is idempotent per reference, and refuses a DIFFERENT reservation under the same reference', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 2 }], 900);
    await inv.reserve(r, [{ variantId: variant.id, quantity: 2 }], 900);
    expect(await stockOf(variant.id)).toMatchObject({ reserved: 2 });
    await expect(
      inv.reserve(r, [{ variantId: variant.id, quantity: 5 }], 900),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('OVERSELL RACE: 25 concurrent buyers for 5 units -> exactly 5 succeed, stock never negative', async () => {
    const { variant } = await fx.product({ stock: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        inv.reserve(ref(), [{ variantId: variant.id, quantity: 1 }], 900),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        response: { code: 'INSUFFICIENT_STOCK' },
      });
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 5, reserved: 5 });
    expect(
      await ctx.prisma.inventoryReservation.count({
        where: { variantId: variant.id, status: 'RESERVED' },
      }),
    ).toBe(5);
  });

  it('OVERSELL RACE with multi-unit lines: 10 concurrent buyers of 3 units, 10 in stock -> exactly 3 succeed', async () => {
    const { variant } = await fx.product({ stock: 10 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        inv.reserve(ref(), [{ variantId: variant.id, quantity: 3 }], 900),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await stockOf(variant.id)).toMatchObject({
      onHand: 10,
      reserved: 9,
    });
  });

  it('concurrent multi-item baskets in opposite orders do not deadlock', async () => {
    const a = await fx.product({ stock: 50 });
    const b = await fx.product({ stock: 50 });
    const jobs = Array.from({ length: 12 }, (_, i) =>
      inv.reserve(
        ref(),
        i % 2
          ? [
              { variantId: a.variant.id, quantity: 1 },
              { variantId: b.variant.id, quantity: 1 },
            ]
          : [
              { variantId: b.variant.id, quantity: 1 },
              { variantId: a.variant.id, quantity: 1 },
            ],
        900,
      ),
    );
    const results = await Promise.allSettled(jobs);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await stockOf(a.variant.id)).reserved).toBe(12);
  });

  it('an EXPIRED reservation can never be committed; the sweeper returns its stock', async () => {
    const { variant } = await fx.product({ stock: 4 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 4 }], 900);
    // Age the reservation past its expiry (created_at moves too, to satisfy the CHECK constraint).
    await ctx.prisma.inventoryReservation.updateMany({
      where: { referenceId: r.referenceId },
      data: {
        createdAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(inv.commit(r)).rejects.toMatchObject({
      response: { code: 'RESERVATION_EXPIRED' },
    });
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 4, reserved: 4 }); // nothing shipped

    const n = await inv.expireDue();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 4, reserved: 0 });
    await expect(inv.commit(r)).rejects.toMatchObject({
      response: { code: 'RESERVATION_EXPIRED' },
    });
  });

  it('release returns stock and is idempotent; a released reservation cannot be committed', async () => {
    const { variant } = await fx.product({ stock: 3 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 3 }], 900);
    expect(await inv.release(r, 'payment failed')).toBe(1);
    expect(await inv.release(r, 'payment failed')).toBe(0);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 3, reserved: 0 });
    // A released hold is gone exactly like an expired one: it can never be committed (payment code then re-reserves or refunds).
    await expect(inv.commit(r)).rejects.toMatchObject({
      response: { code: 'RESERVATION_EXPIRED' },
    });
  });

  it('concurrent commit and expiry: stock is consumed at most once', async () => {
    const { variant } = await fx.product({ stock: 2 });
    const r = ref();
    await inv.reserve(r, [{ variantId: variant.id, quantity: 2 }], 900);
    await Promise.allSettled([
      inv.commit(r),
      inv.release(r, 'race'),
      inv.commit(r),
    ]);
    const row = await stockOf(variant.id);
    expect(row.reserved).toBe(0);
    expect([0, 2]).toContain(row.onHand); // either committed once (0) or released (2) - never -2, never double
  });

  it('emits a transactional low-stock event when availability crosses the threshold', async () => {
    const { variant } = await fx.product({ stock: 8 }); // default threshold 5
    await inv.reserve(ref(), [{ variantId: variant.id, quantity: 4 }], 900);
    const events = await ctx.prisma.outboxEvent.findMany({
      where: { aggregateId: variant.id, eventType: 'inventory.low_stock' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ available: 4, threshold: 5 });
  });

  it('reconciliation finds no drift after all of the above', async () => {
    expect(await inv.reconcile()).toEqual([]);
  });

  it('the stock ledger is append-only for the application role', async () => {
    const { variant } = await fx.product({ stock: 1 });
    await inv.reserve(ref(), [{ variantId: variant.id, quantity: 1 }], 900);
    await expect(
      ctx.prisma.inventoryMovement.updateMany({
        where: { variantId: variant.id },
        data: { reason: 'tamper' },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.inventoryMovement.deleteMany({
        where: { variantId: variant.id },
      }),
    ).rejects.toThrow();
  });
});

describe('admin inventory API', () => {
  it('an INVENTORY_MANAGER can receive stock; adjustments are audited and ledgered', async () => {
    const im = await s.staff('INVENTORY_MANAGER');
    const { variant } = await fx.product({ stock: 0 });
    const res = await ctx
      .http()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authed(im))
      .send({
        sku: variant.sku.toLowerCase(),
        delta: 25,
        type: 'RECEIPT',
        reason: 'PO-1234 delivery',
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      onHand: 25,
      reserved: 0,
      available: 25,
    });
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          action: 'inventory.adjusted',
          actorId: im.userId,
          resourceId: variant.id,
        },
      }),
    ).toBe(1);
    const moves = await ctx
      .http()
      .get(`/api/v1/admin/inventory/movements?sku=${variant.sku}`)
      .set(authed(im));
    expect(moves.body.data[0]).toMatchObject({
      type: 'RECEIPT',
      onHandDelta: 25,
      reason: 'PO-1234 delivery',
      actorId: im.userId,
    });
  });

  it('cannot write stock below what is already reserved for customers', async () => {
    const im = await s.staff('INVENTORY_MANAGER');
    const { variant } = await fx.product({ stock: 5 });
    await inv.reserve(ref(), [{ variantId: variant.id, quantity: 4 }], 900);
    const res = await ctx
      .http()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authed(im))
      .send({ sku: variant.sku, delta: -2, reason: 'shrinkage count' });
    expect(res.status).toBe(409);
    expect(await stockOf(variant.id)).toMatchObject({ onHand: 5, reserved: 4 });
  });

  it('validates input (zero / huge deltas, missing reason, extra fields)', async () => {
    const im = await s.staff('INVENTORY_MANAGER');
    const { variant } = await fx.product({ stock: 5 });
    for (const body of [
      { sku: variant.sku, delta: 0, reason: 'xyz' },
      { sku: variant.sku, delta: 1_000_000, reason: 'xyz' },
      { sku: variant.sku, delta: 1 },
      { sku: variant.sku, delta: 1, reason: 'xyz', onHand: 999 },
      { sku: variant.sku, delta: 1.5, reason: 'xyz' },
    ]) {
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/admin/inventory/adjustments')
            .set(authed(im))
            .send(body)
        ).status,
      ).toBe(400);
    }
  });

  it('roles without inventory.adjust (PRODUCT_MANAGER, customer) are refused', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const customer = await s.session();
    const { variant } = await fx.product({ stock: 5 });
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/admin/inventory/adjustments')
          .set(authed(pm))
          .send({ sku: variant.sku, delta: 5, reason: 'nope nope' })
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/admin/inventory/adjustments')
          .set(authed(customer))
          .send({ sku: variant.sku, delta: 5, reason: 'nope nope' })
      ).status,
    ).toBe(403);
    expect(
      (await ctx.http().get('/api/v1/admin/inventory').set(authed(customer)))
        .status,
    ).toBe(403);
    expect((await stockOf(variant.id)).onHand).toBe(5);
  });
});
