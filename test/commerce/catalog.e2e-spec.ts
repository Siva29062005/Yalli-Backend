import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  CatalogFixture,
  Scenario,
  authed,
  createTestApp,
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
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(200),
]);

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
    const tree = (
      await ctx.http().get('/api/v1/catalog/categories').expect(200)
    ).body.data as {
      slug: string;
      productCount: number;
      children: { slug: string; productCount: number }[];
    }[];
    const node = tree.find((t) => t.slug === parent.slug)!;
    expect(node.productCount).toBe(2);
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
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
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
