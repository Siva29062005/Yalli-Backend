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
    expect(r.failures[0]!.reason).toContain('ledger unavailable');
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
