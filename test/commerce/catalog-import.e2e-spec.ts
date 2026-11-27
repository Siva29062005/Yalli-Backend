import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CatalogImportService } from '../../src/modules/catalog/import/catalog-import.service.js';
import {
  parseImportFile,
  type ImportPlan,
} from '../../src/modules/catalog/import/import-file.js';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let importer: CatalogImportService;
let actorId: string;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  importer = ctx.app.get(CatalogImportService);
  actorId = (await s.staff('ADMIN')).userId;
});
afterAll(() => ctx.close());

const uniq = () => randomBytes(4).toString('hex');
/** A small, valid import file with unique names/SKUs (every test shares one database). */
function makeFile(t = uniq(), over: Record<string, unknown> = {}) {
  return {
    version: 1,
    options: { decodeEntityEncodedDescriptions: true },
    categories: [
      { key: 'kit', name: `Kitchen ${t}` },
      { key: 'store', name: `Storage ${t}`, parentKey: 'kit' },
    ],
    products: [
      {
        key: 'p1',
        name: `Momos Maker ${t}`,
        summary: 'Steams <b>12</b> momos',
        descriptionHtml:
          '&lt;p&gt;Great &amp;amp; sturdy&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
        brand: `Yalli ${t}`,
        categoryKeys: ['store'],
        tags: ['Momos', 'steamer'],
        attributes: [{ name: 'Material', value: 'Steel' }],
        status: 'PUBLISHED',
        variants: [
          {
            sku: `MM-${t}-S`,
            name: 'Small',
            priceMinor: 59_000,
            salePriceMinor: 49_000,
            stock: 7,
          },
          { sku: `MM-${t}-L`, name: 'Large', priceMinor: 89_050, stock: 0 },
        ],
      },
      {
        key: 'p2',
        name: `Cutlery Set ${t}`,
        categoryKeys: ['kit'],
        gstRateBps: 1200,
        variants: [{ sku: `CS-${t}`, priceMinor: 25_000, stock: 3 }],
      },
    ],
    ...over,
  };
}
const plan = (raw: unknown): ImportPlan => {
  const r = parseImportFile(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.plan;
};
const run = (
  raw: unknown,
  o: Partial<{
    apply: boolean;
    updateExisting: boolean;
    publish: boolean;
    actorId: string | null;
  }> = {},
) =>
  importer.run(plan(raw), {
    apply: true,
    updateExisting: false,
    publish: false,
    ...o,
    actorId: o.actorId === undefined ? actorId : o.actorId,
  });
const bySku = (sku: string) =>
  ctx.prisma.productVariant.findFirstOrThrow({
    where: { sku },
    include: { product: true, inventory: true },
  });

describe('dry run', () => {
  it('reports what would happen and writes nothing', async () => {
    const f = makeFile();
    const before = await ctx.prisma.product.count();
    const r = await run(f, { apply: false, actorId: null });
    expect(r.mode).toBe('DRY_RUN');
    expect(r).toMatchObject({
      categories: { created: 2 },
      brands: { created: 1 },
      products: { created: 2, failed: 0 },
      variants: { created: 3 },
    });
    expect(await ctx.prisma.product.count()).toBe(before);
    expect(
      await ctx.prisma.category.count({
        where: { name: { contains: f.categories[0]!.name } },
      }),
    ).toBe(0);
  });

  it('applying requires a named staff actor', async () => {
    await expect(run(makeFile(), { actorId: null })).rejects.toThrow(
      /acting staff user/,
    );
  });
});

describe('apply', () => {
  it('creates categories (parents first), brand, products as DRAFT, exact paise, sanitised text and opening stock through the ledger', async () => {
    const t = uniq();
    const f = makeFile(t);
    const r = await run(f);
    expect(r).toMatchObject({
      mode: 'APPLIED',
      categories: { created: 2 },
      products: { created: 2, failed: 0 },
      variants: { created: 3 },
    });

    const small = await bySku(`MM-${t}-S`);
    expect(small).toMatchObject({
      priceMinor: 59_000,
      salePriceMinor: 49_000,
      name: 'Small',
    });
    expect(small.product).toMatchObject({
      status: 'DRAFT',
      publishedAt: null,
      gstRateBps: 1800,
    });
    expect(small.product.summary).toBe('Steams 12 momos');
    expect(small.product.descriptionHtml).toContain(
      '<p>Great &amp; sturdy</p>',
    );
    expect(small.product.descriptionHtml).not.toContain('<script');
    expect((await bySku(`MM-${t}-L`)).priceMinor).toBe(89_050);
    expect((await bySku(`CS-${t}`)).product.gstRateBps).toBe(1200);

    expect(small.inventory[0]).toMatchObject({ onHand: 7, reserved: 0 });
    const moves = await ctx.prisma.inventoryMovement.findMany({
      where: { variantId: small.id },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      type: 'RECEIPT',
      onHandDelta: 7,
      actorId,
    });
    // zero stock creates the record but no movement
    const large = await bySku(`MM-${t}-L`);
    expect(large.inventory[0]).toMatchObject({ onHand: 0 });
    expect(
      await ctx.prisma.inventoryMovement.count({
        where: { variantId: large.id },
      }),
    ).toBe(0);

    const child = await ctx.prisma.category.findFirstOrThrow({
      where: { name: `Storage ${t}` },
    });
    const parent = await ctx.prisma.category.findFirstOrThrow({
      where: { name: `Kitchen ${t}` },
    });
    expect(child.parentId).toBe(parent.id);
    const tags = await ctx.prisma.productTag.findMany({
      where: { productId: small.productId },
      include: { tag: true },
    });
    expect(tags.map((x) => x.tag.name).sort()).toEqual(['momos', 'steamer']);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'catalog.imported', actorId },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('imported DRAFTs are invisible to shoppers until published', async () => {
    const t = uniq();
    await run(makeFile(t));
    const res = await ctx
      .http()
      .get(
        `/api/v1/catalog/products?q=${encodeURIComponent(`Cutlery Set ${t}`)}`,
      );
    expect(res.body.data).toHaveLength(0);
  });

  it('--publish honours PUBLISHED from the file only; the shop then sells it at the imported price', async () => {
    const t = uniq();
    await run(makeFile(t), { publish: true });
    const published = await bySku(`MM-${t}-S`);
    expect(published.product.status).toBe('PUBLISHED');
    expect(published.product.publishedAt).not.toBeNull();
    expect((await bySku(`CS-${t}`)).product.status).toBe('DRAFT'); // the file said DRAFT (default)

    const list = await ctx
      .http()
      .get(
        `/api/v1/catalog/products?q=${encodeURIComponent(`Momos Maker ${t}`)}`,
      );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].price).toMatchObject({
      amountMinor: 49_000,
      compareAtMinor: 59_000,
    });

    const u = await shop.customer();
    const add = await ctx
      .http()
      .post('/api/v1/cart/items')
      .set(authed(u))
      .send({ variantId: published.id, quantity: 2 });
    expect(add.status).toBe(201);
    expect(add.body.data.totals.totalMinor).toBe(98_000);
  });
});

describe('idempotency and protection of live data', () => {
  it('running the same file again changes nothing (no duplicates, no extra stock)', async () => {
    const t = uniq();
    const f = makeFile(t);
    await run(f);
    const again = await run(f);
    expect(again).toMatchObject({
      categories: { created: 0, existing: 2 },
      brands: { created: 0, existing: 1 },
      products: { created: 0, updated: 0, skipped: 2, failed: 0 },
    });
    const v = await bySku(`MM-${t}-S`);
    expect(v.inventory[0]!.onHand).toBe(7);
    expect(
      await ctx.prisma.inventoryMovement.count({ where: { variantId: v.id } }),
    ).toBe(1);
    expect(
      await ctx.prisma.product.count({ where: { name: `Momos Maker ${t}` } }),
    ).toBe(1);
  });

  it('--update-existing refreshes catalogue data and adds new variants, but NEVER overwrites live stock or status', async () => {
    const t = uniq();
    await run(makeFile(t), { publish: true });
    const v = await bySku(`MM-${t}-S`);
    // the shop has sold/received since: live stock is now 40
    await ctx.prisma.inventory.updateMany({
      where: { variantId: v.id },
      data: { onHand: 40 },
    });

    const changed = makeFile(t);
    changed.products[0]!.name = `Momos Maker ${t}`; // same slug
    changed.products[0]!.variants = [
      { sku: `MM-${t}-S`, name: 'Small', priceMinor: 64_000, stock: 999 }, // new price, "stock" must be ignored
      { sku: `MM-${t}-L`, name: 'Large', priceMinor: 89_050, stock: 0 },
      { sku: `MM-${t}-XL`, name: 'XL', priceMinor: 99_000, stock: 5 }, // brand-new variant gets opening stock
    ];
    changed.products[0]!.summary = 'Updated summary';
    const r = await run(changed, { updateExisting: true });
    // both products in the file exist; variants: S, L and the cutlery SKU are updated, XL is new
    expect(r.products).toMatchObject({ updated: 2, skipped: 0, failed: 0 });
    expect(r.variants).toMatchObject({ created: 1, updated: 3 });

    const after = await bySku(`MM-${t}-S`);
    expect(after).toMatchObject({ priceMinor: 64_000, salePriceMinor: null });
    expect(after.inventory[0]!.onHand).toBe(40); // untouched
    expect(after.product.status).toBe('PUBLISHED'); // untouched
    expect(after.product.summary).toBe('Updated summary');
    expect((await bySku(`MM-${t}-XL`)).inventory[0]!.onHand).toBe(5);
  });
});

describe('failure isolation', () => {
  it('a SKU that belongs to another product fails only that product; the rest import', async () => {
    const taken = await shop.fx.product({ priceMinor: 10_000 });
    const t = uniq();
    const f = makeFile(t);
    f.products.splice(1, 0, {
      key: 'clash',
      name: `Clashing ${t}`,
      categoryKeys: ['kit'],
      variants: [{ sku: taken.variant.sku, priceMinor: 12_345, stock: 1 }],
    } as never);
    const r = await run(f);
    expect(r.products).toMatchObject({ created: 2, failed: 1 });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ product: 'clash' });
    expect(r.failures[0]!.reason).toContain('belongs to another product');
    expect(
      await ctx.prisma.product.count({ where: { name: `Clashing ${t}` } }),
    ).toBe(0);
    expect(
      (
        await ctx.prisma.productVariant.findUniqueOrThrow({
          where: { id: taken.variant.id },
        })
      ).priceMinor,
    ).toBe(10_000);
    expect(
      await ctx.prisma.product.count({ where: { name: `Cutlery Set ${t}` } }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'catalog.imported', outcome: 'FAILURE' },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('a product is all-or-nothing: if its stock receipt fails, no product or variant is left behind', async () => {
    const t = uniq();
    const f = makeFile(t);
    const spy = vi
      .spyOn(ctx.app.get(CatalogImportService)['inventory'], 'adjustInTx')
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    const r = await run(f);
    spy.mockRestore();
    expect(r.products.failed).toBe(1);
    // an unexpected error is logged on the server, never shown as raw text (the console sends the report to a browser)
    expect(r.failures[0]!.reason).toBe(
      'internal error (details are in the server log)',
    );
    expect(
      await ctx.prisma.product.count({ where: { name: `Momos Maker ${t}` } }),
    ).toBe(0);
    expect(
      await ctx.prisma.productVariant.count({
        where: { sku: { startsWith: `MM-${t}` } },
      }),
    ).toBe(0);
    // re-running completes the work (idempotent resume)
    const resume = await run(f);
    expect(resume.products).toMatchObject({
      created: 1,
      skipped: 1,
      failed: 0,
    });
  });
});

describe('console import (POST /admin/catalog/import)', () => {
  const upload = (
    who: Awaited<ReturnType<Scenario['staff']>>,
    body: unknown,
    fields: Record<string, string> = {},
  ) => {
    let req = ctx
      .http()
      .post('/api/v1/admin/catalog/import')
      .set(authed(who))
      .attach('file', Buffer.from(JSON.stringify(body)), {
        filename: 'catalog.json',
        contentType: 'application/json',
      });
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req;
  };

  it('dry run first, then the same file is applied; another file or other options need their own dry run', async () => {
    const admin = await s.staff('ADMIN');
    const file = makeFile();
    // applying without a dry run is refused
    const blind = await upload(admin, file, { apply: 'true' });
    expect(blind.status).toBe(400);
    expect(blind.body.error.code).toBe('IMPORT_DRY_RUN_REQUIRED');

    const dry = await upload(admin, file).expect(200);
    expect(dry.body.data).toMatchObject({
      mode: 'DRY_RUN',
      products: { created: 2 },
    });
    expect(
      await ctx.prisma.product.count({
        where: { name: file.products[0]!.name },
      }),
    ).toBe(0); // the dry run wrote nothing
    // the dry run does not cover other options
    expect(
      (await upload(admin, file, { apply: 'true', publish: 'true' })).body.error
        ?.code,
    ).toBe('IMPORT_DRY_RUN_REQUIRED');

    const applied = await upload(admin, file, { apply: 'true' }).expect(200);
    expect(applied.body.data).toMatchObject({
      mode: 'APPLIED',
      products: { created: 2, failed: 0 },
    });
    // DRAFT by default, even though the file says PUBLISHED
    const p = await ctx.prisma.product.findFirstOrThrow({
      where: { name: file.products[0]!.name },
    });
    expect(p.status).toBe('DRAFT');
    // the confirmation is used up
    expect(
      (await upload(admin, file, { apply: 'true' })).body.error?.code,
    ).toBe('IMPORT_DRY_RUN_REQUIRED');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'catalog.imported', actorId: admin.userId },
      }),
    ).toBe(1);
  });

  it('updating existing products needs products.update, and an import price change is audited from/to', async () => {
    const admin = await s.staff('ADMIN');
    const file = makeFile();
    for (const prod of file.products)
      for (const v of prod.variants) v.stock = 0;
    await upload(admin, file).expect(200);
    await upload(admin, file, { apply: 'true' }).expect(200);
    // same products, new price, updateExisting
    const repriced = structuredClone(file);
    repriced.products[1]!.variants[0]!.priceMinor = 27_500;
    const opts = { updateExisting: 'true' };
    // a role that may create and price products but not EDIT them cannot overwrite existing ones
    const role = await ctx.prisma.role.upsert({
      where: { name: 'TEST_IMPORT_CREATOR' },
      update: {},
      create: { name: 'TEST_IMPORT_CREATOR', rank: 40, isSystem: false },
    });
    for (const name of ['products.read', 'products.create', 'pricing.update']) {
      const perm = await ctx.prisma.permission.findUniqueOrThrow({
        where: { name },
      });
      await ctx.prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    const creator = await s.staff('TEST_IMPORT_CREATOR');
    expect((await upload(creator, repriced, opts)).status).toBe(403);

    await upload(admin, repriced, opts).expect(200);
    await upload(admin, repriced, { ...opts, apply: 'true' }).expect(200);
    const variant = await ctx.prisma.productVariant.findFirstOrThrow({
      where: { sku: repriced.products[1]!.variants[0]!.sku },
    });
    expect(variant.priceMinor).toBe(27_500);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'catalog.price.changed', resourceId: variant.id },
    });
    expect(audit).toMatchObject({ actorId: admin.userId });
    expect(audit.metadata).toMatchObject({
      source: 'catalog-import',
      from: { priceMinor: 25_000 },
      to: { priceMinor: 27_500 },
    });
  });

  it('sale dates in the file are stored with the sale price (a time-limited special stays time-limited)', async () => {
    const file = makeFile();
    const v = file.products[0]!.variants[0]! as Record<string, unknown>;
    v['saleStartsAt'] = '2026-11-01T00:00:00+05:30';
    v['saleEndsAt'] = '2026-12-05T00:00:00+05:30';
    const report = await run(file, { apply: true });
    expect(report.products.failed).toBe(0);
    const stored = await ctx.prisma.productVariant.findFirstOrThrow({
      where: { sku: v['sku'] as string },
    });
    expect(stored.saleEndsAt?.toISOString()).toBe('2026-12-04T18:30:00.000Z');
    expect(stored.saleStartsAt?.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    // dates without a sale price, or an end before the start, make the file invalid
    const bad = makeFile();
    const b = bad.products[1]!.variants[0]! as Record<string, unknown>;
    b['saleEndsAt'] = '2026-12-05T00:00:00+05:30';
    expect(parseImportFile(bad).ok).toBe(false);
  });

  it('confirming the same dry run twice runs the import once', async () => {
    const admin = await s.staff('ADMIN');
    const file = makeFile();
    for (const prod of file.products)
      for (const v of prod.variants) v.stock = 0;
    await upload(admin, file).expect(200);
    const [a, b] = await Promise.all([
      upload(admin, file, { apply: 'true' }),
      upload(admin, file, { apply: 'true' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('a bad file writes nothing and lists the problems; publish and stock need their own permissions', async () => {
    const admin = await s.staff('ADMIN');
    const bad = makeFile(uniq(), {
      products: [{ key: 'x', name: '', variants: [] }],
    });
    const res = await upload(admin, bad);
    expect(res.status).toBe(400);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    const notJson = await ctx
      .http()
      .post('/api/v1/admin/catalog/import')
      .set(authed(admin))
      .attach('file', Buffer.from('{oops'), {
        filename: 'c.json',
        contentType: 'application/json',
      });
    expect(notJson.status).toBe(400);

    // PRODUCT_MANAGER has no inventory.adjust: a file with stock is refused, one without is fine
    const pm = await s.staff('PRODUCT_MANAGER');
    const withStock = await upload(pm, makeFile());
    expect(withStock.status).toBe(403);
    const noStock = makeFile();
    for (const prod of noStock.products)
      for (const v of prod.variants) v.stock = 0;
    await upload(pm, noStock).expect(200);
    // ORDER_MANAGER may not import at all; unknown option fields are refused
    expect((await upload(await s.staff('ORDER_MANAGER'), noStock)).status).toBe(
      403,
    );
    expect((await upload(admin, noStock, { force: 'true' })).status).toBe(400);
  });
});
