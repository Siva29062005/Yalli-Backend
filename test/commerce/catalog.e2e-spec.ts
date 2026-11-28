import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CatalogFixture,
  Scenario,
  authed,
  createTestApp,
  type Session,
  type TestContext,
  freshIp,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let fx: CatalogFixture;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  fx = new CatalogFixture(ctx);
});
afterAll(() => ctx.close());

const list = (query: Record<string, string | number>) =>
  ctx.http().get('/api/v1/catalog/products').query(query);
/** A real (decodable) PNG carrying EXIF data: uploads are re-encoded, so it must be a genuine image. */
const PNG = await sharp({
  create: { width: 4, height: 3, channels: 3, background: '#3a7' },
})
  .png()
  .withExif({ IFD0: { Make: 'PhoneCo', Copyright: 'secret-gps-owner' } })
  .toBuffer();

describe('public catalogue visibility', () => {
  it('shows only published, live products with an active variant; drafts/archived/deleted are invisible everywhere', async () => {
    const cat = await fx.category('Visibility');
    const live = await fx.product({
      name: 'Visible Lamp',
      categoryIds: [cat.id],
    });
    const draft = await fx.product({
      name: 'Draft Lamp',
      categoryIds: [cat.id],
      status: 'DRAFT',
    });
    const archived = await fx.product({
      name: 'Archived Lamp',
      categoryIds: [cat.id],
      status: 'ARCHIVED',
    });
    const deleted = await fx.product({
      name: 'Deleted Lamp',
      categoryIds: [cat.id],
    });
    await ctx.prisma.product.update({
      where: { id: deleted.product.id },
      data: { deletedAt: new Date() },
    });
    const noVariant = await fx.product({
      name: 'Inactive Variant Lamp',
      categoryIds: [cat.id],
    });
    await ctx.prisma.productVariant.updateMany({
      where: { productId: noVariant.product.id },
      data: { isActive: false },
    });

    const res = await list({ category: cat.slug }).expect(200);
    expect(res.body.data.map((p: { slug: string }) => p.slug)).toEqual([
      live.product.slug,
    ]);
    expect(res.body.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
    for (const hidden of [draft, archived, deleted, noVariant]) {
      expect(
        (
          await ctx
            .http()
            .get(`/api/v1/catalog/products/${hidden.product.slug}`)
        ).status,
      ).toBe(404);
    }
    expect(
      (await ctx.http().get(`/api/v1/catalog/products/${live.product.slug}`))
        .status,
    ).toBe(200);
  });

  it('shows the sale price with the struck-through price, and never exposes exact stock levels', async () => {
    const { product } = await fx.product({
      priceMinor: 60_000,
      salePriceMinor: 50_000,
      stock: 3,
    });
    const res = await ctx
      .http()
      .get(`/api/v1/catalog/products/${product.slug}`)
      .expect(200);
    expect(res.body.data.variants[0]).toMatchObject({
      price: {
        amountMinor: 50_000,
        compareAtMinor: 60_000,
        onSale: true,
        currency: 'INR',
      },
      inStock: true,
      lowStock: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/onHand|reserved|"available"/);
  });
});

describe('listing: filters, sorting, pagination', () => {
  let cat: { id: string; slug: string };
  beforeAll(async () => {
    cat = await fx.category('Sorting');
    await fx.product({
      name: 'Alpha Bottle',
      priceMinor: 30_000,
      categoryIds: [cat.id],
    });
    await fx.product({
      name: 'Bravo Bottle',
      priceMinor: 10_000,
      categoryIds: [cat.id],
      stock: 0,
    });
    await fx.product({
      name: 'Charlie Bottle',
      priceMinor: 20_000,
      salePriceMinor: 5_000,
      categoryIds: [cat.id],
    });
  });
  const names = (r: { body: { data: { name: string }[] } }) =>
    r.body.data.map((p) => p.name);

  it('sorts by effective price and by name', async () => {
    expect(
      names(await list({ category: cat.slug, sort: 'price_asc' })),
    ).toEqual(['Charlie Bottle', 'Bravo Bottle', 'Alpha Bottle']);
    expect(
      names(await list({ category: cat.slug, sort: 'price_desc' })),
    ).toEqual(['Alpha Bottle', 'Bravo Bottle', 'Charlie Bottle']);
    expect(
      names(await list({ category: cat.slug, sort: 'name_desc' })),
    ).toEqual(['Charlie Bottle', 'Bravo Bottle', 'Alpha Bottle']);
  });

  it('filters by price range (effective price), in-stock and specials', async () => {
    expect(
      names(
        await list({
          category: cat.slug,
          minPrice: 9_000,
          maxPrice: 25_000,
          sort: 'name_asc',
        }),
      ),
    ).toEqual(['Bravo Bottle']);
    expect(
      names(
        await list({ category: cat.slug, inStock: 'true', sort: 'name_asc' }),
      ),
    ).toEqual(['Alpha Bottle', 'Charlie Bottle']);
    expect(names(await list({ category: cat.slug, special: 'true' }))).toEqual([
      'Charlie Bottle',
    ]);
  });

  it('paginates with honest totals and caps the page size', async () => {
    const p1 = await list({
      category: cat.slug,
      pageSize: 2,
      page: 1,
      sort: 'name_asc',
    });
    const p2 = await list({
      category: cat.slug,
      pageSize: 2,
      page: 2,
      sort: 'name_asc',
    });
    const p9 = await list({ category: cat.slug, pageSize: 2, page: 9 });
    expect(names(p1)).toEqual(['Alpha Bottle', 'Bravo Bottle']);
    expect(names(p2)).toEqual(['Charlie Bottle']);
    expect(p1.body.meta).toEqual({
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
    expect(p9.body.data).toEqual([]);
    expect(p9.body.meta.total).toBe(3);
    expect((await list({ pageSize: 61 })).status).toBe(400);
    expect((await list({ page: 0 })).status).toBe(400);
  });

  it('a category page includes products of its sub-categories; brand pages filter by brand', async () => {
    const parent = await fx.category('Kitchen and Dining');
    const child = await fx.category('Storage', parent.id);
    const brand = await fx.brand(`Yalli ${randomBytes(3).toString('hex')}`);
    await fx.product({ name: 'Parent Item', categoryIds: [parent.id] });
    await fx.product({
      name: 'Child Item',
      categoryIds: [child.id],
      brandId: brand.id,
    });
    expect(
      names(await list({ category: parent.slug, sort: 'name_asc' })),
    ).toEqual(['Child Item', 'Parent Item']);
    expect(names(await list({ category: child.slug }))).toEqual(['Child Item']);
    expect(names(await list({ brand: brand.slug }))).toEqual(['Child Item']);
    // a published product whose only variant is switched off is not on the page, so it is not counted either
    const hidden = await fx.product({
      name: 'Hidden Item',
      categoryIds: [parent.id],
    });
    await ctx.prisma.productVariant.update({
      where: { id: hidden.variant.id },
      data: { isActive: false },
    });
    const tree = (
      await ctx.http().get('/api/v1/catalog/categories').expect(200)
    ).body.data as {
      slug: string;
      productCount: number;
      children: { slug: string; productCount: number }[];
    }[];
    const node = tree.find((t) => t.slug === parent.slug)!;
    expect(node.productCount).toBe(2); // not 3: the hidden item is left out like on the listing
    expect(node.children).toEqual([
      expect.objectContaining({ slug: child.slug, productCount: 1 }),
    ]);
  });
});

describe('search', () => {
  const tag = `tag${randomBytes(3).toString('hex')}`;
  let sku = '';
  beforeAll(async () => {
    const m = await fx.product({
      name: '3 in 1 Momos Maker Machine',
      summary: 'Steamer for dumplings',
      tags: [tag],
    });
    sku = m.variant.sku;
    await fx.product({ name: 'Garden Tool Set' });
  });
  const hits = async (q: string) =>
    ((await list({ q })).body.data as { name: string }[]).map((p) => p.name);

  it('finds by word, partial word, summary, SKU and tag', async () => {
    expect(await hits('momos')).toContain('3 in 1 Momos Maker Machine');
    expect(await hits('momo')).toContain('3 in 1 Momos Maker Machine');
    expect(await hits('dumplings')).toContain('3 in 1 Momos Maker Machine');
    expect(await hits(sku.toLowerCase())).toEqual([
      '3 in 1 Momos Maker Machine',
    ]);
    expect(await hits(tag)).toEqual(['3 in 1 Momos Maker Machine']);
  });

  it('treats LIKE wildcards literally ("%" does not match everything)', async () => {
    expect(await hits('%')).toEqual([]);
    expect(await hits('_')).toEqual([]);
  });

  it('SQL injection attempts are inert: no error leakage, no data change', async () => {
    // Other test files insert products concurrently, so measure only rows that existed BEFORE this test:
    // an injected DROP/DELETE/UPDATE would destroy or alter exactly these.
    const start = new Date();
    const existing = { createdAt: { lte: start } };
    const before = await ctx.prisma.product.count({ where: existing });
    for (const q of [
      "'; DROP TABLE products; --",
      "' OR '1'='1",
      'momos) OR (1=1',
      '\\',
      "momos' UNION SELECT password_hash FROM users --",
      '<script>alert(1)</script>',
    ]) {
      const res = await list({ q });
      expect(res.status, q).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(
        /syntax|postgres|argon2|password_hash/i,
      );
    }
    for (const sort of ['price_asc; DROP TABLE products', 'p.name', '1'])
      expect((await list({ sort })).status).toBe(400);
    for (const category of ["x' OR 1=1 --", '../etc'])
      expect((await list({ category })).status).toBe(400);
    expect(await ctx.prisma.product.count({ where: existing })).toBe(before);
  });
});

describe('admin catalogue management', () => {
  let cat: { id: string };
  beforeAll(async () => {
    cat = await fx.category('Admin');
  });
  const newProduct = (over: Record<string, unknown> = {}) => ({
    name: '12 Pcs Silicone Cooking Utensils Set with Holder',
    summary: 'Heat-resistant set',
    descriptionHtml:
      '<ul><li><strong>AVOID CHEAPER</strong> utensils</li></ul><script>steal()</script><img src=x onerror=alert(1)>',
    categoryIds: [cat.id],
    tags: ['Kitchen', 'kitchen', 'Utensils'],
    attributes: [{ name: 'Material', value: 'Silicone' }],
    gstRateBps: 1800,
    variants: [
      { sku: `UTN-${randomBytes(3).toString('hex')}`, priceMinor: 59_000 },
    ],
    ...over,
  });

  it('stores names, summaries, tags and attributes as plain text: "&" stays "&" (no HTML entities)', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const name = `Pots & Pans 5 > 3 ${randomBytes(3).toString('hex')}`;
    const created = await ctx
      .http()
      .post('/api/v1/admin/products')
      .set(authed(pm))
      .send(
        newProduct({
          name,
          summary: 'Tea & coffee, 5 > 3',
          tags: ['Kitchen & Dining'],
          attributes: [{ name: 'Size & fit', value: '<b>2 L</b> & up' }],
        }),
      );
    expect(created.status).toBe(201);
    const p = created.body.data;
    expect(p.name).toBe(name);
    expect(p.summary).toBe('Tea & coffee, 5 > 3');
    expect(p.tags).toEqual(['kitchen & dining']);
    expect(p.attributes).toMatchObject([
      { name: 'Size & fit', value: '2 L & up' },
    ]);
    expect(p.slug).not.toMatch(/amp|lt|gt-/);
  });

  it('a PRODUCT_MANAGER creates a draft (sanitised, invisible), publishes it (visible), and it is audited', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const created = await ctx
      .http()
      .post('/api/v1/admin/products')
      .set(authed(pm))
      .send(newProduct());
    expect(created.status).toBe(201);
    const p = created.body.data;
    expect(p).toMatchObject({
      status: 'DRAFT',
      slug: expect.stringMatching(
        /^12-pcs-silicone-cooking-utensils-set-with-holder/,
      ),
    });
    expect(p.descriptionHtml).toBe(
      '<ul><li><strong>AVOID CHEAPER</strong> utensils</li></ul>',
    );
    expect(p.tags.sort()).toEqual(['kitchen', 'utensils']);
    expect(p.variants[0]).toMatchObject({ available: 0 }); // stock record created at zero
    expect(p.attributes).toMatchObject([
      { name: 'Material', value: 'Silicone' },
    ]);
    expect(
      (await ctx.http().get(`/api/v1/catalog/products/${p.slug}`)).status,
    ).toBe(404);

    await ctx
      .http()
      .post(`/api/v1/admin/products/${p.id}/publish`)
      .set(authed(pm))
      .expect(200);
    expect(
      (await ctx.http().get(`/api/v1/catalog/products/${p.slug}`)).status,
    ).toBe(200);
    const actions = (
      await ctx.prisma.auditLog.findMany({
        where: { actorId: pm.userId, resourceId: p.id },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'catalog.product.created',
        'catalog.product.status_changed',
      ]),
    );
  });

  it('rejects mass assignment (status, id, deletedAt) and invalid money', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    for (const extra of [
      { status: 'PUBLISHED' },
      { id: 'x' },
      { deletedAt: null },
      { publishedAt: '2026-01-01T00:00:00Z' },
    ]) {
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/admin/products')
            .set(authed(pm))
            .send(newProduct(extra))
        ).status,
      ).toBe(400);
    }
    for (const variants of [
      [{ sku: 'X-1', priceMinor: 590.5 }],
      [{ sku: 'X-2', priceMinor: 0 }],
      [{ sku: 'X-3', priceMinor: 100, salePriceMinor: 100 }],
      [{ sku: 'bad sku!', priceMinor: 100 }],
      [{ sku: 'X-4', priceMinor: '100' }],
    ]) {
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/admin/products')
            .set(authed(pm))
            .send(newProduct({ variants }))
        ).status,
      ).toBe(400);
    }
  });

  it('SKUs are unique case-insensitively', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const sku = `DUP-${randomBytes(3).toString('hex')}`;
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/admin/products')
          .set(authed(pm))
          .send(newProduct({ variants: [{ sku, priceMinor: 100 }] }))
      ).status,
    ).toBe(201);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/admin/products')
          .set(authed(pm))
          .send(
            newProduct({
              variants: [{ sku: sku.toLowerCase(), priceMinor: 100 }],
            }),
          )
      ).status,
    ).toBe(409);
  });

  it('price changes need pricing.update in ADDITION to products.update, and are audited with before/after', async () => {
    // A custom role that may edit products but not prices.
    const editorRole = await ctx.prisma.role.upsert({
      where: { name: 'TEST_CATALOG_EDITOR' },
      update: {},
      create: { name: 'TEST_CATALOG_EDITOR', rank: 40, isSystem: false },
    });
    for (const name of ['products.read', 'products.update']) {
      const perm = await ctx.prisma.permission.findUniqueOrThrow({
        where: { name },
      });
      await ctx.prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: editorRole.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: editorRole.id, permissionId: perm.id },
      });
    }
    const editor = await s.staff('TEST_CATALOG_EDITOR');
    const pm = await s.staff('PRODUCT_MANAGER');
    const { variant } = await fx.product({ priceMinor: 59_000 });

    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/variants/${variant.id}`)
          .set(authed(editor))
          .send({ priceMinor: 1 })
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/variants/${variant.id}`)
          .set(authed(editor))
          .send({ name: 'Blue' })
      ).status,
    ).toBe(200);
    expect(
      (
        await ctx.prisma.productVariant.findUniqueOrThrow({
          where: { id: variant.id },
        })
      ).priceMinor,
    ).toBe(59_000);
    // Price fields sent UNCHANGED (a form that saves everything) are not a price change: allowed, and not audited.
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/variants/${variant.id}`)
          .set(authed(editor))
          .send({
            name: 'Green',
            priceMinor: 59_000,
            salePriceMinor: null,
            saleStartsAt: null,
            saleEndsAt: null,
          })
      ).status,
    ).toBe(200);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'catalog.price.changed', resourceId: variant.id },
      }),
    ).toBe(0);

    await ctx
      .http()
      .patch(`/api/v1/admin/variants/${variant.id}`)
      .set(authed(pm))
      .send({ salePriceMinor: 49_000 })
      .expect(200);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'catalog.price.changed', resourceId: variant.id },
    });
    expect(audit).toMatchObject({ actorId: pm.userId });
    expect(audit.metadata).toMatchObject({
      from: { salePriceMinor: null },
      to: { salePriceMinor: 49_000 },
    });
    // Sale price must stay below the list price even through partial updates.
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/variants/${variant.id}`)
          .set(authed(pm))
          .send({ priceMinor: 40_000 })
      ).status,
    ).toBe(400);
  });

  it('deleting a variant needs products.delete: an editor (PRODUCT_MANAGER) is refused, an ADMIN may', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const admin = await s.staff('ADMIN');
    const { variant } = await fx.product({ priceMinor: 10_000 });
    const del = (actor: Session) =>
      ctx
        .http()
        .delete(`/api/v1/admin/variants/${variant.id}`)
        .set(authed(actor));
    expect((await del(pm)).status).toBe(403);
    expect(
      (
        await ctx.prisma.productVariant.findUniqueOrThrow({
          where: { id: variant.id },
        })
      ).deletedAt,
    ).toBeNull();
    expect((await del(admin)).status).toBe(200);
  });

  it('roles without catalogue permissions are refused (ORDER_MANAGER cannot create, customer cannot read admin views)', async () => {
    const om = await s.staff('ORDER_MANAGER');
    const customer = await s.session();
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/admin/products')
          .set(authed(om))
          .send(newProduct())
      ).status,
    ).toBe(403);
    expect(
      (await ctx.http().get('/api/v1/admin/products').set(authed(customer)))
        .status,
    ).toBe(403);
  });

  it('prevents category cycles and refuses to delete non-empty categories', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const a = (
      await ctx
        .http()
        .post('/api/v1/admin/categories')
        .set(authed(pm))
        .send({ name: `A ${randomBytes(2).toString('hex')}` })
    ).body.data;
    const b = (
      await ctx
        .http()
        .post('/api/v1/admin/categories')
        .set(authed(pm))
        .send({ name: `B ${randomBytes(2).toString('hex')}`, parentId: a.id })
    ).body.data;
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/categories/${a.id}`)
          .set(authed(pm))
          .send({ parentId: b.id })
      ).status,
    ).toBe(409);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/categories/${a.id}`)
          .set(authed(pm))
          .send({ parentId: a.id })
      ).status,
    ).toBe(409);
    const admin = await s.staff('ADMIN');
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/admin/categories/${a.id}`)
          .set(authed(admin))
      ).status,
    ).toBe(409);
  });
});

describe('admin product list shows what staff need at a glance', () => {
  it('reports categories, the current customer price range and sellable stock, with the storefront price rules', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const cat = await fx.category('Glance Kitchen');
    const tag = randomBytes(4).toString('hex');
    // a live sale on one variant: the customer price is the sale price, not the list price
    const { product } = await fx.product({
      name: `Glance Steamer ${tag}`,
      priceMinor: 79_900,
      salePriceMinor: 49_000,
      stock: 12,
      categoryIds: [cat.id],
    });
    // a second variant whose sale has ENDED (regular price applies), plus an inactive one that must not count
    const second = await ctx.prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `GL2-${tag}`,
        priceMinor: 99_900,
        salePriceMinor: 10_000,
        saleEndsAt: new Date(Date.now() - 86_400_000),
      },
    });
    await ctx.prisma.inventory.create({
      data: {
        variantId: second.id,
        warehouseId: (
          await ctx.prisma.warehouse.findFirstOrThrow({
            where: { isDefault: true },
          })
        ).id,
        onHand: 5,
        reserved: 2,
      },
    });
    await ctx.prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `GL3-${tag}`,
        priceMinor: 1_000,
        isActive: false,
      },
    });

    const res = await ctx
      .http()
      .get('/api/v1/admin/products')
      .query({ q: `Glance Steamer ${tag}` })
      .set(authed(pm))
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: product.id,
      categories: ['Glance Kitchen'],
      price: { minMinor: 49_000, maxMinor: 99_900, onSale: true },
      stock: { available: 12 + 3 }, // 12 on hand + (5 on hand - 2 reserved)
    });
    // customers (no products.read) still cannot see any of it
    await ctx
      .http()
      .get('/api/v1/admin/products')
      .set(authed(await s.session()))
      .expect(403);
  });

  it('a product with no live variant has no price and no stock', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const tag = randomBytes(4).toString('hex');
    const { product, variant } = await fx.product({
      name: `Glance Empty ${tag}`,
      stock: 4,
    });
    await ctx.prisma.productVariant.update({
      where: { id: variant.id },
      data: { isActive: false },
    });
    const res = await ctx
      .http()
      .get('/api/v1/admin/products')
      .query({ q: `Glance Empty ${tag}` })
      .set(authed(pm))
      .expect(200);
    expect(res.body.data[0]).toMatchObject({
      id: product.id,
      price: null,
      stock: { available: 0, lowStock: false },
    });
  });
});

describe('admin brands and product lookups for the console', () => {
  it('brand counts show live products; deleting a brand keeps its products (no brand); only products.delete may delete', async () => {
    const admin = await s.staff('ADMIN');
    const brand = await fx.brand();
    const { product } = await fx.product({ brandId: brand.id });
    const gone = await fx.product({ brandId: brand.id });
    await ctx.prisma.product.update({
      where: { id: gone.product.id },
      data: { deletedAt: new Date() },
    });
    const listed = (
      await ctx
        .http()
        .get('/api/v1/admin/brands')
        .set(authed(admin))
        .expect(200)
    ).body.data as { id: string; _count: { products: number } }[];
    expect(listed.find((b) => b.id === brand.id)?._count.products).toBe(1);
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/admin/brands/${brand.id}`)
          .set(authed(await s.staff('ORDER_MANAGER')))
      ).status,
    ).toBe(403);
    await ctx
      .http()
      .delete(`/api/v1/admin/brands/${brand.id}`)
      .set(authed(admin))
      .expect(200);
    expect(
      (
        await ctx.prisma.product.findUniqueOrThrow({
          where: { id: product.id },
        })
      ).brandId,
    ).toBeNull();
  });

  it('GET /admin/products?ids= returns exactly those products (a coupon picker shows their names); bad ids are refused', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const a = await fx.product();
    const b = await fx.product();
    await fx.product();
    const res = await ctx
      .http()
      .get(
        `/api/v1/admin/products?ids=${a.product.id},${b.product.id}&pageSize=60`,
      )
      .set(authed(pm))
      .expect(200);
    expect((res.body.data as { id: string }[]).map((p) => p.id).sort()).toEqual(
      [a.product.id, b.product.id].sort(),
    );
    for (const bad of [
      'ids=not-a-uuid',
      `ids=${a.product.id},`,
      `ids=${Array.from({ length: 61 }, () => a.product.id).join(',')}`,
    ])
      expect(
        (await ctx.http().get(`/api/v1/admin/products?${bad}`).set(authed(pm)))
          .status,
      ).toBe(400);
  });
});

describe('image order and variant images (PATCH /admin/images/:id)', () => {
  it('moves an image in the gallery (clean 0..n-1 order), links it to a variant, and checks ownership and permission', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const { product, variant } = await fx.product();
    const other = await fx.product();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          await ctx
            .http()
            .post(`/api/v1/admin/products/${product.id}/images`)
            .set(authed(pm))
            .attach('file', PNG, {
              filename: `p${i}.png`,
              contentType: 'image/png',
            })
            .expect(201)
        ).body.data.id,
      );
    const patch = (id: string, body: Record<string, unknown>, who = pm) =>
      ctx
        .http()
        .patch(`/api/v1/admin/images/${id}`)
        .set(authed(who))
        .send(body);
    const moved = await patch(ids[2]!, { position: 0 }).expect(200);
    expect(
      (moved.body.data.images as { id: string; position: number }[]).map(
        (i) => [i.id, i.position],
      ),
    ).toEqual([
      [ids[2], 0],
      [ids[0], 1],
      [ids[1], 2],
    ]);
    const linked = await patch(ids[0]!, {
      variantId: variant.id,
      altText: 'Steel <b>lid</b>',
    }).expect(200);
    expect(
      (
        linked.body.data.images as {
          id: string;
          variantId: string | null;
          altText: string;
        }[]
      ).find((i) => i.id === ids[0]),
    ).toMatchObject({ variantId: variant.id, altText: 'Steel lid' });
    // a variant of ANOTHER product, nothing to change, unknown fields, the wrong role, an unknown image
    expect((await patch(ids[0]!, { variantId: other.variant.id })).status).toBe(
      400,
    );
    expect((await patch(ids[0]!, {})).status).toBe(400);
    expect((await patch(ids[0]!, { storageKey: 'x.png' })).status).toBe(400);
    expect(
      (await patch(ids[0]!, { position: 1 }, await s.staff('ORDER_MANAGER')))
        .status,
    ).toBe(403);
    expect(
      (await patch('0190a7c0-0000-7000-8000-000000000000', { position: 1 }))
        .status,
    ).toBe(404);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'catalog.image.updated', resourceId: product.id },
      }),
    ).toBe(2);
  });
});

describe('image upload security', () => {
  const upload = async (
    bytes: Buffer,
    filename: string,
    contentType: string,
  ) => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const { product } = await fx.product();
    return {
      res: await ctx
        .http()
        .post(`/api/v1/admin/products/${product.id}/images`)
        .set(authed(pm))
        .attach('file', bytes, { filename, contentType }),
      product,
    };
  };

  it('accepts a real PNG, stores it under a server-generated name and serves it safely', async () => {
    const { res, product } = await upload(
      PNG,
      '../../evil name.png',
      'image/png',
    );
    expect(res.status).toBe(201);
    const url = res.body.data.url as string;
    const key = url.split('/').pop()!;
    expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
    const served = await ctx.http().get(`/media/${key}`).expect(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    // re-encoded: still a PNG of the same picture, but without the EXIF data the upload carried
    const servedMeta = await sharp(served.body as Buffer).metadata();
    expect(servedMeta).toMatchObject({ format: 'png', width: 4, height: 3 });
    expect(servedMeta.exif).toBeUndefined();
    expect(
      (served.body as Buffer).includes(Buffer.from('secret-gps-owner')),
    ).toBe(false);
    const pub = await ctx
      .http()
      .get(`/api/v1/catalog/products/${product.slug}`);
    expect(pub.body.data.images[0].url).toBe(url);
  });

  it.each([
    [
      'HTML disguised as PNG',
      Buffer.from('<html><script>alert(document.cookie)</script></html>'),
      'photo.png',
      'image/png',
    ],
    [
      'SVG with script',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      ),
      'logo.svg',
      'image/svg+xml',
    ],
    [
      'Windows executable',
      Buffer.concat([Buffer.from('MZ'), randomBytes(100)]),
      'setup.jpg',
      'image/jpeg',
    ],
    [
      'PNG signature on random bytes (not a decodable image)',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        randomBytes(200),
      ]),
      'fake.png',
      'image/png',
    ],
    [
      'PHP web shell',
      Buffer.from('<?php system($_GET["c"]); ?>'),
      'shell.php.png',
      'image/png',
    ],
  ])(
    'rejects %s by content, whatever the filename / declared type',
    async (_n, bytes, name, type) => {
      const { res } = await upload(bytes, name, type);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    },
  );

  it('rejects files over 5 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)]);
    const { res } = await upload(big, 'big.png', 'image/png');
    expect(res.status).toBe(413);
  });

  it('serves nothing that is not a registered image key (no traversal, no listing)', async () => {
    for (const path of [
      '/media/..%2f..%2fpackage.json',
      '/media/../package.json',
      '/media/0190a7c0-0000-7000-8000-000000000000.png',
      '/media/x.svg',
      '/media/',
    ]) {
      expect([404]).toContain((await ctx.http().get(path)).status);
    }
  });
});

describe('the storefront server (server-side rendering) has its own budget', () => {
  const KEY = 'test-frontend-server-key-0123456789abcdef'; // vitest.config.e2e.ts
  const burst = async (headers: Record<string, string>, n = 130) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++)
      statuses.push(
        (
          await ctx
            .http()
            .get(`/api/v1/catalog/products?q=ssr${i}`)
            .set(headers)
        ).status,
      );
    return statuses;
  };

  it('public catalogue reads with the frontend key are not cut off at the per-IP limit (all shoppers share its IP)', async () => {
    const ip = freshIp();
    const statuses = await burst({
      'X-Forwarded-For': ip,
      'X-Frontend-Key': KEY,
    });
    expect(statuses.every((c) => c === 200)).toBe(true);
  });

  it('each keyed request counts ONCE against the storefront budget (both rate-limit guards run)', async () => {
    const { createHash } = await import('node:crypto');
    const key = `rl:frontend-server:${createHash('sha256').update('frontend-server').digest('hex').slice(0, 32)}`;
    const before = Number((await ctx.store.get(key)) ?? 0);
    await burst({ 'X-Forwarded-For': freshIp(), 'X-Frontend-Key': KEY }, 5);
    expect(Number(await ctx.store.get(key)) - before).toBe(5);
  });

  it('a wrong key gets the normal per-IP limit', async () => {
    const statuses = await burst({
      'X-Forwarded-For': freshIp(),
      'X-Frontend-Key': `${KEY.slice(0, -1)}X`,
    });
    expect(statuses.slice(120).every((c) => c === 429)).toBe(true);
  });

  it('the key never relaxes writes or private routes', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++)
      statuses.push(
        (
          await ctx
            .http()
            .post('/api/v1/auth/login')
            .set({ 'X-Forwarded-For': ip, 'X-Frontend-Key': KEY })
            .send({
              email: `nobody${i}@example.test`,
              password: 'wrong-password-123',
            })
        ).status,
      );
    // login-ip (30 per 10 minutes) still applies to a POST, key or not
    expect(statuses.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(statuses.slice(30).every((c) => c === 429)).toBe(true);
  });
});

describe('abuse protection on the public search', () => {
  it('has its own per-IP budget (varying the query cannot defeat the cache and exhaust the database), per client', async () => {
    const heavy = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++)
      statuses.push(
        (
          await ctx
            .http()
            .get(`/api/v1/catalog/products?q=term${i}`)
            .set('X-Forwarded-For', heavy)
        ).status,
      );
    expect(statuses.slice(0, 120).every((c) => c === 200)).toBe(true);
    expect(statuses.slice(120).every((c) => c === 429)).toBe(true);
    // another client is unaffected
    expect(
      (
        await ctx
          .http()
          .get('/api/v1/catalog/products?q=term0')
          .set('X-Forwarded-For', freshIp())
      ).status,
    ).toBe(200);
  });
});

describe('a corrupted category tree cannot take the storefront down', () => {
  it('a parent loop (two staff edits racing) does not make the public category queries run away', async () => {
    const a = await ctx.prisma.category.create({
      data: {
        name: 'Loop A',
        slug: `loop-a-${randomBytes(3).toString('hex')}`,
      },
    });
    const b = await ctx.prisma.category.create({
      data: {
        name: 'Loop B',
        slug: `loop-b-${randomBytes(3).toString('hex')}`,
        parentId: a.id,
      },
    });
    await ctx.prisma.category.update({
      where: { id: a.id },
      data: { parentId: b.id },
    }); // the loop
    // a published product INSIDE the loop forces PostgreSQL to actually walk it (it skips empty joins)
    await new CatalogFixture(ctx).product({ categoryIds: [b.id] });
    const started = Date.now();
    const tree = await ctx
      .http()
      .get('/api/v1/catalog/categories')
      .set('X-Forwarded-For', freshIp());
    const list = await ctx
      .http()
      .get(`/api/v1/catalog/products?category=${a.slug}`)
      .set('X-Forwarded-For', freshIp());
    expect(tree.status).toBe(200);
    expect(list.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('storefront listing details (Phase 10)', () => {
  it('a product whose variants cost different amounts is marked "from" its lowest price; one price is not', async () => {
    const t = randomBytes(3).toString('hex');
    const multi = await fx.product({ name: `Multi ${t}`, priceMinor: 40_000 });
    await ctx.prisma.productVariant.create({
      data: {
        productId: multi.product.id,
        sku: `MULTI-B-${t}`.toUpperCase(),
        priceMinor: 70_000,
        position: 1,
      },
    });
    const single = await fx.product({
      name: `Single ${t}`,
      priceMinor: 40_000,
    });
    const cards = (await list({ q: t, pageSize: 60 })).body.data as {
      slug: string;
      price: { amountMinor: number; fromPrice: boolean };
    }[];
    const card = (slug: string) => cards.find((c) => c.slug === slug)!;
    expect(card(multi.product.slug).price).toMatchObject({
      amountMinor: 40_000,
      fromPrice: true,
    });
    expect(card(single.product.slug).price).toMatchObject({ fromPrice: false });
  });

  it('brands can be limited to a category (with subcategories): only brands that have products there', async () => {
    const parent = await fx.category('Brand scope');
    const child = await fx.category('Brand scope child', parent.id);
    const inside = await fx.brand();
    const outside = await fx.brand();
    await fx.product({ brandId: inside.id, categoryIds: [child.id] });
    await fx.product({ brandId: outside.id });
    const scoped = (
      await ctx.http().get(`/api/v1/catalog/brands?category=${parent.slug}`)
    ).body.data as {
      slug: string;
      productCount: number;
    }[];
    expect(scoped.map((b) => b.slug)).toContain(inside.slug);
    expect(scoped.map((b) => b.slug)).not.toContain(outside.slug);
    expect(scoped.find((b) => b.slug === inside.slug)!.productCount).toBe(1);
    const all = (await ctx.http().get('/api/v1/catalog/brands')).body.data as {
      slug: string;
    }[];
    expect(all.map((b) => b.slug)).toEqual(
      expect.arrayContaining([inside.slug, outside.slug]),
    );
    expect(
      (await ctx.http().get('/api/v1/catalog/brands?category=BAD%20SLUG'))
        .status,
    ).toBe(400);
  });

  it('brand counts leave out products with no active variant (they are not listed either)', async () => {
    const brand = await fx.brand();
    await fx.product({ brandId: brand.id });
    const { variant } = await fx.product({ brandId: brand.id });
    await ctx.prisma.productVariant.update({
      where: { id: variant.id },
      data: { isActive: false },
    });
    const all = (await ctx.http().get('/api/v1/catalog/brands')).body.data as {
      slug: string;
      productCount: number;
    }[];
    expect(all.find((b) => b.slug === brand.slug)?.productCount).toBe(1);
    const listed = await ctx
      .http()
      .get(`/api/v1/catalog/products?brand=${brand.slug}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
  });
});

describe('data repair migration 20261127000000_plain_text_entities', () => {
  it('decodes text stored HTML-encoded by the old stripTags, leaves slugs alone, and skips colliding unique names', async () => {
    const t = randomBytes(3).toString('hex');
    const { product } = await fx.product({ name: `Pots ${t}` });
    await ctx.prisma.product.update({
      where: { id: product.id },
      data: {
        name: `Pots &amp; Pans ${t}`,
        summary: '5 &gt; 3 &amp;&amp; 2 &lt; 4',
      },
    });
    const kept = await fx.brand(`Fish & Chips ${t}`); // already decoded: an encoded twin must not collide with it
    const twin = await ctx.prisma.brand.create({
      data: { name: `Fish &amp; Chips ${t}`, slug: `twin-${t}` },
    });
    const brand = await ctx.prisma.brand.create({
      data: { name: `Salt &amp; Pepper ${t}`, slug: `salt-${t}` },
    });
    const literal = await ctx.prisma.category.create({
      data: { name: `Literal &amp;lt; ${t}`, slug: `literal-${t}` },
    });

    const sql = readFileSync(
      join(
        import.meta.dirname,
        '../../prisma/migrations/20261127000000_plain_text_entities/migration.sql',
      ),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .split(/;\s*$/m) // statement ends: a ";" at the end of a line (the entities inside strings end with ";" too)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const st of statements) await ctx.prisma.$executeRawUnsafe(st); // static file content, no input

    const p = await ctx.prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(p.name).toBe(`Pots & Pans ${t}`);
    expect(p.summary).toBe('5 > 3 && 2 < 4');
    expect(p.slug).toBe(product.slug);
    expect(
      (await ctx.prisma.brand.findUniqueOrThrow({ where: { id: brand.id } }))
        .name,
    ).toBe(`Salt & Pepper ${t}`);
    expect(
      (await ctx.prisma.brand.findUniqueOrThrow({ where: { id: twin.id } }))
        .name,
    ).toBe(`Fish &amp; Chips ${t}`);
    expect(
      (await ctx.prisma.brand.findUniqueOrThrow({ where: { id: kept.id } }))
        .name,
    ).toBe(`Fish & Chips ${t}`);
    expect(
      (
        await ctx.prisma.category.findUniqueOrThrow({
          where: { id: literal.id },
        })
      ).name,
    ).toBe(`Literal &lt; ${t}`);
  });
});
