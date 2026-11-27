import { Logger } from '@nestjs/common';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  type Session,
  type TestContext,
} from '../support/test-app.js';

// Warehouses are global state (the default one receives stock): this file has its own database.
let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let im: Session;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  im = await s.staff('INVENTORY_MANAGER');
});
afterAll(() => ctx.close());

const api = (who: Session) => ({
  create: (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/admin/warehouses').set(authed(who)).send(body),
  update: (code: string, body: Record<string, unknown>) =>
    ctx
      .http()
      .patch(`/api/v1/admin/warehouses/${code}`)
      .set(authed(who))
      .send(body),
  threshold: (body: Record<string, unknown>) =>
    ctx
      .http()
      .patch('/api/v1/admin/inventory/threshold')
      .set(authed(who))
      .send(body),
});

describe('low-stock thresholds', () => {
  it('sets the level for one SKU in one warehouse; the list and the low-stock filter use it', async () => {
    const { variant } = await shop.fx.product({ stock: 8 });
    const main = await ctx.prisma.warehouse.findFirstOrThrow({
      where: { isDefault: true },
    });
    await api(im)
      .threshold({
        sku: variant.sku.toLowerCase(),
        warehouseCode: main.code,
        lowStockThreshold: 10,
      })
      .expect(200);
    const low = await ctx
      .http()
      .get(`/api/v1/admin/inventory?sku=${variant.sku}&lowStock=true`)
      .set(authed(im))
      .expect(200);
    expect(low.body.data).toEqual([
      expect.objectContaining({ sku: variant.sku, lowStockThreshold: 10 }),
    ]);
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          action: 'inventory.threshold_changed',
          resourceId: variant.id,
        },
      }),
    ).toBe(1);
    for (const [body, status] of [
      [
        { sku: variant.sku, warehouseCode: main.code, lowStockThreshold: -1 },
        400,
      ],
      [
        { sku: variant.sku, warehouseCode: main.code, lowStockThreshold: 2.5 },
        400,
      ],
      [
        { sku: 'NO-SUCH-SKU', warehouseCode: main.code, lowStockThreshold: 3 },
        404,
      ],
      [{ sku: variant.sku, warehouseCode: 'NOPE', lowStockThreshold: 3 }, 404],
    ] as const)
      expect((await api(im).threshold(body)).status).toBe(status);
    expect(
      (
        await api(await s.staff('ORDER_MANAGER')).threshold({
          sku: variant.sku,
          warehouseCode: main.code,
          lowStockThreshold: 1,
        })
      ).status,
    ).toBe(403);
  });
});

describe('warehouses', () => {
  it('create, rename, make default; the default is always active; one with stock cannot be switched off', async () => {
    const created = await api(im)
      .create({ code: 'chn-1', name: 'Chennai' })
      .expect(201);
    expect(created.body.data).toMatchObject({
      code: 'CHN-1',
      isDefault: false,
      isActive: true,
    });
    expect(
      (await api(im).create({ code: 'CHN-1', name: 'Again' })).status,
    ).toBe(409);
    for (const bad of [
      { code: 'x', name: 'Ok name' },
      { code: 'A B', name: 'Ok' },
      { code: 'OK', name: 'x' },
    ])
      expect((await api(im).create(bad)).status).toBe(400);

    await api(im).update('CHN-1', { name: 'Chennai hub' }).expect(200);
    const oldDefault = await ctx.prisma.warehouse.findFirstOrThrow({
      where: { isDefault: true },
    });
    // the default cannot be switched off; stock in it neither
    const off = await api(im).update(oldDefault.code, { isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('WAREHOUSE_IS_DEFAULT');

    await api(im).update('CHN-1', { isDefault: true }).expect(200);
    const defaults = await ctx.prisma.warehouse.findMany({
      where: { isDefault: true },
    });
    expect(defaults.map((w) => w.code)).toEqual(['CHN-1']);
    // the old default still holds the fixtures' stock: it stays on
    const withStock = await api(im).update(oldDefault.code, {
      isActive: false,
    });
    expect(withStock.status).toBe(409);
    expect(withStock.body.error.code).toBe('WAREHOUSE_HAS_STOCK');

    // an empty warehouse can be switched off, and cannot become the default while off
    await api(im).create({ code: 'EMPTY', name: 'Spare room' }).expect(201);
    await api(im).update('EMPTY', { isActive: false }).expect(200);
    const inactive = await api(im).update('EMPTY', { isDefault: true });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('WAREHOUSE_INACTIVE');
    expect((await api(im).update('NOPE', { name: 'Nope' })).status).toBe(404);
    expect((await api(im).update('EMPTY', {})).status).toBe(400);

    // put the original default back (other suites assume it)
    await api(im).update(oldDefault.code, { isDefault: true }).expect(200);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'inventory.warehouse_changed', actorId: im.userId },
      }),
    ).toBeGreaterThanOrEqual(6);
  });

  it('after another warehouse becomes the default, stock can be received there and cancels restock where the goods came from', async () => {
    const { variant } = await shop.fx.product({ stock: 5 });
    const oldDefault = await ctx.prisma.warehouse.findFirstOrThrow({
      where: { isDefault: true },
    });
    const u = await shop.customer();
    const order = await shop.order(u, [{ variantId: variant.id, quantity: 2 }]);
    await shop.paid(u, order.id); // 2 units committed from the old default

    await api(im).create({ code: 'NEWDEF', name: 'New default' }).expect(201);
    await api(im).update('NEWDEF', { isDefault: true }).expect(200);
    const newDefault = await ctx.prisma.warehouse.findUniqueOrThrow({
      where: { code: 'NEWDEF' },
    });
    // receiving stock for an OLD variant in the new warehouse creates its stock row
    await ctx
      .http()
      .post('/api/v1/admin/inventory/adjustments')
      .set(authed(im))
      .send({
        sku: variant.sku,
        delta: 4,
        type: 'RECEIPT',
        reason: 'First delivery to the new warehouse',
      })
      .expect(201);
    const row = (warehouseId: string) =>
      ctx.prisma.inventory.findUniqueOrThrow({
        where: {
          variantId_warehouseId: { variantId: variant.id, warehouseId },
        },
      });
    expect((await row(newDefault.id)).onHand).toBe(4);

    // the customer cancels the paid order: the 2 units go back to the warehouse they were reserved from
    const beforeOld = (await row(oldDefault.id)).onHand;
    await ctx
      .http()
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(authed(u))
      .send({})
      .expect(200);
    expect((await row(oldDefault.id)).onHand).toBe(beforeOld + 2);
    expect((await row(newDefault.id)).onHand).toBe(4);
    expect((await shop.dbOrder(order.id)).status).toBe('REFUNDED');

    await api(im).update(oldDefault.code, { isDefault: true }).expect(200);
  });

  it('only inventory.adjust may change warehouses', async () => {
    for (const who of [await s.staff('ORDER_MANAGER'), await s.session()]) {
      expect((await api(who).create({ code: 'X1', name: 'Nope' })).status).toBe(
        403,
      );
      expect((await api(who).update('X1', { name: 'Nope' })).status).toBe(403);
    }
  });
});
