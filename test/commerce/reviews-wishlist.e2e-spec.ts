import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  Scenario,
  Shop,
  authed,
  createTestApp,
  type Session,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
let shop: Shop;
let moderator: Awaited<ReturnType<Scenario['staff']>>;
let manager: Awaited<ReturnType<Scenario['staff']>>;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
  moderator = await s.staff('ADMIN');
  manager = await s.staff('ORDER_MANAGER');
});
afterAll(() => ctx.close());

type Cust = Session & { addressId: string };
const reviewsUrl = (slug: string) => `/api/v1/catalog/products/${slug}/reviews`;
const goodReview = (over: Record<string, unknown> = {}) => ({
  rating: 5,
  title: 'Brilliant',
  body: 'Works exactly as described and feels sturdy.',
  ...over,
});
const fulfil = (orderId: string, body: Record<string, unknown>) =>
  ctx
    .http()
    .post(`/api/v1/admin/orders/${orderId}/fulfilment`)
    .set(authed(manager))
    .send(body);

/** A customer who has really received `product` (paid -> shipped -> delivered). */
async function buyer(opts: { deliver?: boolean } = {}) {
  const { product, variant } = await shop.fx.product({
    priceMinor: 80_000,
    stock: 50,
  });
  const u: Cust = await shop.customer();
  const order = await shop.order(u, [{ variantId: variant.id }]);
  await shop.paid(u, order.id);
  if (opts.deliver !== false) {
    await fulfil(order.id, { status: 'PROCESSING' }).expect(200);
    await fulfil(order.id, {
      status: 'SHIPPED',
      trackingCarrier: 'DTDC',
      trackingNumber: `T${randomBytes(6).toString('hex')}`,
    }).expect(200);
    await fulfil(order.id, { status: 'DELIVERED' }).expect(200);
  }
  return { product, variant, u, order };
}
/** Another delivered customer for an existing product. */
async function anotherBuyer(variantId: string) {
  const u: Cust = await shop.customer();
  const order = await shop.order(u, [{ variantId }]);
  await shop.paid(u, order.id);
  await fulfil(order.id, { status: 'PROCESSING' }).expect(200);
  await fulfil(order.id, {
    status: 'SHIPPED',
    trackingCarrier: 'DTDC',
    trackingNumber: `T${randomBytes(6).toString('hex')}`,
  }).expect(200);
  await fulfil(order.id, { status: 'DELIVERED' }).expect(200);
  return u;
}
const post = (u: Session, slug: string, body: Record<string, unknown>) =>
  ctx.http().post(reviewsUrl(slug)).set(authed(u)).send(body);
const decide = (actor: Session, id: string, body: Record<string, unknown>) =>
  ctx
    .http()
    .post(`/api/v1/admin/reviews/${id}/decision`)
    .set(authed(actor))
    .send(body);
const approved = async (u: Session, slug: string, body = goodReview()) => {
  const r = await post(u, slug, body);
  expect(r.status).toBe(201);
  await decide(moderator, r.body.data.id, { decision: 'APPROVED' }).expect(200);
  return r.body.data.id as string;
};

describe('who may review', () => {
  it('only a customer who RECEIVED the product (not browsers, not unpaid, not merely paid)', async () => {
    const { product, u } = await buyer();
    const stranger = await shop.customer();
    const r1 = await post(stranger, product.slug, goodReview());
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('REVIEW_REQUIRES_PURCHASE');

    const paidOnly = await buyer({ deliver: false });
    const r2 = await post(paidOnly.u, paidOnly.product.slug, goodReview());
    expect(r2.status).toBe(403);

    const ok = await post(u, product.slug, goodReview());
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('PENDING');
  });

  it('"verified purchase" means they kept it: a fully returned and refunded item no longer qualifies or shows the badge', async () => {
    const { product, variant, u, order } = await buyer();
    await approved(u, product.slug);
    const badge = async () =>
      (await ctx.http().get(reviewsUrl(product.slug))).body.data.find(
        (r: { reviewer: string }) => r.reviewer === 'Asha K.',
      )?.verifiedPurchase;
    expect(await badge()).toBe(true);
    // the customer sent every unit back and was refunded (the return flow itself is tested elsewhere)
    const item = await ctx.prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    await ctx.prisma.returnRequest.create({
      data: {
        orderId: order.id,
        orderItemId: item.id,
        userId: u.userId,
        quantity: item.quantity,
        reason: 'FAULTY',
        opened: false,
        status: 'REFUNDED',
      },
    });
    expect(await badge()).toBe(false); // the review stays, the badge goes
    // someone else who returned everything cannot write a new review
    const other = await anotherBuyer(variant.id);
    const otherOrder = await ctx.prisma.order.findFirstOrThrow({
      where: { userId: other.userId },
      include: { items: true },
    });
    await ctx.prisma.returnRequest.create({
      data: {
        orderId: otherOrder.id,
        orderItemId: otherOrder.items[0]!.id,
        userId: other.userId,
        quantity: otherOrder.items[0]!.quantity,
        reason: 'FAULTY',
        opened: false,
        status: 'REFUNDED',
      },
    });
    expect((await post(other, product.slug, goodReview())).status).toBe(403);
  });

  it('anonymous callers cannot post, and drafts do not exist publicly', async () => {
    const { product } = await buyer();
    expect(
      (await ctx.http().post(reviewsUrl(product.slug)).send(goodReview()))
        .status,
    ).toBe(401);
    await ctx.prisma.product.update({
      where: { id: product.id },
      data: { status: 'DRAFT' },
    });
    expect((await ctx.http().get(reviewsUrl(product.slug))).status).toBe(404);
    expect(
      (await ctx.http().get(`${reviewsUrl(product.slug)}/summary`)).status,
    ).toBe(404);
  });

  it('one review per product', async () => {
    const { product, u } = await buyer();
    await post(u, product.slug, goodReview()).then((r) =>
      expect(r.status).toBe(201),
    );
    const again = await post(u, product.slug, goodReview({ rating: 1 }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REVIEW_EXISTS');
  });
});

describe('input safety', () => {
  it('rejects bad ratings, short text, unknown fields and mass-assignment of status/user', async () => {
    const { product, u } = await buyer();
    for (const bad of [
      { rating: 0 },
      { rating: 6 },
      { rating: 4.5 },
      { rating: '5' },
      { body: 'too short' },
      { status: 'APPROVED' },
      { userId: '00000000-0000-7000-8000-000000000000' },
      { productId: '00000000-0000-7000-8000-000000000000' },
    ])
      expect((await post(u, product.slug, goodReview(bad))).status).toBe(400);
    // The e2e environment caps request bodies at 1 KB (production: 100 KB), so an oversized review is refused outright.
    expect(
      (await post(u, product.slug, goodReview({ body: 'x'.repeat(3000) })))
        .status,
    ).toBe(413);
    expect(
      await ctx.prisma.productReview.count({ where: { userId: u.userId } }),
    ).toBe(0);
  });

  it('stores plain text only: markup is stripped, and markup-only bodies are refused', async () => {
    const { product, u } = await buyer();
    const bad = await post(
      u,
      product.slug,
      goodReview({ body: '<script>alert(1)1234567890</script>' }),
    );
    expect(bad.status).toBe(400);
    const r = await post(
      u,
      product.slug,
      goodReview({
        title: '<img src=x onerror=alert(1)>Nice',
        body: 'Really <b>good</b> <script>steal()</script>product overall',
      }),
    );
    expect(r.status).toBe(201);
    expect(r.body.data.title).toBe('Nice');
    expect(r.body.data.body).toBe('Really good product overall');
  });

  it('keeps "&", "<" and ">" as text; a body full of "&" no longer grows past the column (was HTML-encoded, then 500)', async () => {
    const { product, u } = await buyer();
    // 900 characters (the e2e body limit is 1 KB): encoded as `&amp;` this was ~4,500, past VarChar(2000).
    const body = `Pots & pans ${'&'.repeat(882)} 5 > 3`;
    expect(body).toHaveLength(900);
    const r = await post(
      u,
      product.slug,
      goodReview({ title: 'Fish & chips <3', body }),
    );
    expect(r.status).toBe(201);
    expect(r.body.data.title).toBe('Fish & chips <3');
    expect(r.body.data.body).toBe(body);
  });
});

describe('moderation and visibility', () => {
  it('a review is invisible until approved, then public with a masked name and no ids', async () => {
    const { product, u } = await buyer();
    const created = await post(u, product.slug, goodReview());
    const id = created.body.data.id as string;
    expect(
      (await ctx.http().get(reviewsUrl(product.slug))).body.data,
    ).toHaveLength(0);
    expect(
      (await ctx.http().get(`${reviewsUrl(product.slug)}/summary`)).body.data
        .count,
    ).toBe(0);

    await decide(moderator, id, { decision: 'APPROVED' }).expect(200);
    const pub = await ctx.http().get(reviewsUrl(product.slug));
    expect(pub.body.data).toHaveLength(1);
    expect(pub.body.data[0]).toMatchObject({
      rating: 5,
      verifiedPurchase: true,
      reviewer: 'Asha K.',
    });
    const raw = JSON.stringify(pub.body);
    for (const secret of [u.userId, u.email, 'userId', 'status', 'moderat'])
      expect(raw).not.toContain(secret);
  });

  it('rejected reviews stay hidden, and the author sees the reason', async () => {
    const { product, u } = await buyer();
    const created = await post(u, product.slug, goodReview());
    const id = created.body.data.id as string;
    expect((await decide(moderator, id, { decision: 'REJECTED' })).status).toBe(
      400,
    ); // reason required
    await decide(moderator, id, {
      decision: 'REJECTED',
      note: 'Contains an external link',
    }).expect(200);
    expect(
      (await ctx.http().get(reviewsUrl(product.slug))).body.data,
    ).toHaveLength(0);
    const mine = await ctx.http().get('/api/v1/me/reviews').set(authed(u));
    expect(mine.body.data[0]).toMatchObject({
      status: 'REJECTED',
      moderationNote: 'Contains an external link',
    });
  });

  it('a review can be decided once; the decision is audited with the moderator', async () => {
    const { product, u } = await buyer();
    const id = (await post(u, product.slug, goodReview())).body.data
      .id as string;
    await decide(moderator, id, { decision: 'APPROVED' }).expect(200);
    const second = await decide(moderator, id, {
      decision: 'REJECTED',
      note: 'changed my mind',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('REVIEW_ALREADY_DECIDED');
    const row = await ctx.prisma.productReview.findUniqueOrThrow({
      where: { id },
    });
    expect(row).toMatchObject({
      status: 'APPROVED',
      moderatedById: moderator.userId,
    });
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'review.decided', resourceId: id },
    });
    expect(audit?.actorId).toBe(moderator.userId);
    expect(
      (
        await decide(moderator, '00000000-0000-7000-8000-000000000000', {
          decision: 'APPROVED',
        })
      ).status,
    ).toBe(404);
  });

  it('a published review can be taken down with a reason; only moderators, only from APPROVED', async () => {
    const { product, u } = await buyer();
    const id = await approved(u, product.slug);
    const takeDown = (actor: Session, body: Record<string, unknown>) =>
      ctx
        .http()
        .post(`/api/v1/admin/reviews/${id}/take-down`)
        .set(authed(actor))
        .send(body);
    expect((await takeDown(moderator, {})).status).toBe(400); // a reason is required
    expect((await takeDown(u, { note: 'Abusive language' })).status).toBe(403);
    expect(
      (await takeDown(await s.staff('ORDER_MANAGER'), { note: 'Abusive' }))
        .status,
    ).toBe(403);
    await takeDown(moderator, { note: 'Abusive language' }).expect(200);
    const pub = await ctx.http().get(reviewsUrl(product.slug)).expect(200);
    expect((pub.body.data as { id: string }[]).some((r) => r.id === id)).toBe(
      false,
    );
    const mine = await ctx.http().get('/api/v1/me/reviews').set(authed(u));
    expect(
      (mine.body.data as { id: string }[]).find((r) => r.id === id),
    ).toMatchObject({ status: 'REJECTED', moderationNote: 'Abusive language' });
    const again = await takeDown(moderator, { note: 'Abusive language' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REVIEW_NOT_PUBLISHED');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'review.taken_down', resourceId: id },
      }),
    ).toBe(1);
  });

  it('only staff with reviews.moderate may see the queue or decide', async () => {
    const { product, u } = await buyer();
    const id = (await post(u, product.slug, goodReview())).body.data
      .id as string;
    const support = await s.staff('INVENTORY_MANAGER');
    for (const actor of [u, support]) {
      expect(
        (await ctx.http().get('/api/v1/admin/reviews').set(authed(actor)))
          .status,
      ).toBe(403);
      expect((await decide(actor, id, { decision: 'APPROVED' })).status).toBe(
        403,
      );
    }
    expect((await ctx.http().get('/api/v1/admin/reviews')).status).toBe(401);
    const queue = await ctx
      .http()
      .get('/api/v1/admin/reviews')
      .set(authed(moderator));
    expect(queue.status).toBe(200);
    expect(queue.body.data.some((r: { id: string }) => r.id === id)).toBe(true);
    expect(
      (await ctx.prisma.productReview.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('PENDING');
  });

  it('the database refuses an approved review with no moderator on record', async () => {
    const { product, u } = await buyer();
    const id = (await post(u, product.slug, goodReview())).body.data
      .id as string;
    await expect(
      ctx.prisma
        .$executeRaw`UPDATE product_reviews SET status = 'APPROVED' WHERE id = ${id}::uuid`,
    ).rejects.toThrow();
    await expect(
      ctx.prisma
        .$executeRaw`UPDATE product_reviews SET rating = 9 WHERE id = ${id}::uuid`,
    ).rejects.toThrow();
  });
});

describe('editing and deleting', () => {
  it('editing sends an approved review back to moderation and hides it again', async () => {
    const { product, u } = await buyer();
    const id = await approved(u, product.slug);
    expect(
      (await ctx.http().get(reviewsUrl(product.slug))).body.data,
    ).toHaveLength(1);
    const edit = await ctx
      .http()
      .patch(`/api/v1/me/reviews/${id}`)
      .set(authed(u))
      .send({ body: 'Changed my mind after a month of use.', rating: 3 });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ status: 'PENDING', rating: 3 });
    expect(
      (await ctx.http().get(reviewsUrl(product.slug))).body.data,
    ).toHaveLength(0);
    const row = await ctx.prisma.productReview.findUniqueOrThrow({
      where: { id },
    });
    expect(row.moderatedById).toBeNull();
  });

  it("someone else's review is a 404 to edit or delete, and a customer cannot change status", async () => {
    const { product, u } = await buyer();
    const id = (await post(u, product.slug, goodReview())).body.data
      .id as string;
    const other = await shop.customer();
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/me/reviews/${id}`)
          .set(authed(other))
          .send({ rating: 1 })
      ).status,
    ).toBe(404);
    expect(
      (await ctx.http().delete(`/api/v1/me/reviews/${id}`).set(authed(other)))
        .status,
    ).toBe(404);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/me/reviews/${id}`)
          .set(authed(u))
          .send({ status: 'APPROVED' })
      ).status,
    ).toBe(400);
    expect(
      (await ctx.prisma.productReview.findUniqueOrThrow({ where: { id } }))
        .rating,
    ).toBe(5);
    expect(
      (await ctx.http().delete(`/api/v1/me/reviews/${id}`).set(authed(u)))
        .status,
    ).toBe(200);
    expect(await ctx.prisma.productReview.count({ where: { id } })).toBe(0);
  });
});

describe('rating summary', () => {
  it('counts only approved reviews and averages from integer counts', async () => {
    const { product, variant, u } = await buyer();
    await approved(u, product.slug, goodReview({ rating: 5 }));
    const u2 = await anotherBuyer(variant.id);
    await approved(u2, product.slug, goodReview({ rating: 4 }));
    const u3 = await anotherBuyer(variant.id);
    await approved(u3, product.slug, goodReview({ rating: 1 }));
    const u4 = await anotherBuyer(variant.id);
    await post(u4, product.slug, goodReview({ rating: 1 })); // pending: must not count
    const res = await ctx.http().get(`${reviewsUrl(product.slug)}/summary`);
    expect(res.body.data).toMatchObject({ count: 3, average: 3.3 });
    expect(res.body.data.distribution).toEqual({
      '1': 1,
      '2': 0,
      '3': 0,
      '4': 1,
      '5': 1,
    });
    const list = await ctx.http().get(`${reviewsUrl(product.slug)}?pageSize=2`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.meta.total).toBe(3);

    // The listing card shows the same rating (served by the reviews module, not a catalogue SQL join).
    const cards = await ctx
      .http()
      .get(`/api/v1/catalog/products?q=${encodeURIComponent(product.name)}`);
    const card = cards.body.data.find(
      (c: { slug: string }) => c.slug === product.slug,
    );
    expect(card.rating).toEqual({ average: 3.3, count: 3 });
  });

  it('shows no rating on listing cards for products without approved reviews', async () => {
    const { product } = await shop.fx.product();
    const cards = await ctx
      .http()
      .get(`/api/v1/catalog/products?q=${encodeURIComponent(product.name)}`);
    const card = cards.body.data.find(
      (c: { slug: string }) => c.slug === product.slug,
    );
    expect(card.rating).toEqual({ average: null, count: 0 });
  });
});

describe('wishlist', () => {
  it('saves, lists with live prices, is idempotent, and removes', async () => {
    const { product } = await shop.fx.product({
      priceMinor: 70_000,
      salePriceMinor: 50_000,
    });
    const u = await shop.customer();
    const put = () =>
      ctx.http().put(`/api/v1/me/wishlist/${product.slug}`).set(authed(u));
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const list = await ctx.http().get('/api/v1/me/wishlist').set(authed(u));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      slug: product.slug,
      inStock: true,
      price: { amountMinor: 50_000, compareAtMinor: 70_000, onSale: true },
    });
    expect(
      await ctx.prisma.wishlistItem.count({ where: { userId: u.userId } }),
    ).toBe(1);
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/me/wishlist/${product.slug}`)
          .set(authed(u))
      ).status,
    ).toBe(200);
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/me/wishlist/${product.slug}`)
          .set(authed(u))
      ).status,
    ).toBe(200);
    expect(
      (await ctx.http().get('/api/v1/me/wishlist').set(authed(u))).body.data,
    ).toHaveLength(0);
  });

  it('is private: another customer never sees or removes your items; anonymous gets 401', async () => {
    const { product } = await shop.fx.product();
    const a = await shop.customer();
    const b = await shop.customer();
    await ctx
      .http()
      .put(`/api/v1/me/wishlist/${product.slug}`)
      .set(authed(a))
      .expect(200);
    expect(
      (await ctx.http().get('/api/v1/me/wishlist').set(authed(b))).body.data,
    ).toHaveLength(0);
    await ctx
      .http()
      .delete(`/api/v1/me/wishlist/${product.slug}`)
      .set(authed(b))
      .expect(200);
    expect(
      await ctx.prisma.wishlistItem.count({ where: { userId: a.userId } }),
    ).toBe(1);
    expect((await ctx.http().get('/api/v1/me/wishlist')).status).toBe(401);
    expect(
      (await ctx.http().put(`/api/v1/me/wishlist/${product.slug}`)).status,
    ).toBe(401);
  });

  it('cannot save an unpublished or unknown product; an unpublished saved item drops out of the cards', async () => {
    const { product } = await shop.fx.product({ status: 'DRAFT' });
    const live = await shop.fx.product();
    const u = await shop.customer();
    expect(
      (
        await ctx
          .http()
          .put(`/api/v1/me/wishlist/${product.slug}`)
          .set(authed(u))
      ).status,
    ).toBe(404);
    expect(
      (
        await ctx
          .http()
          .put('/api/v1/me/wishlist/no-such-product')
          .set(authed(u))
      ).status,
    ).toBe(404);
    await ctx
      .http()
      .put(`/api/v1/me/wishlist/${live.product.slug}`)
      .set(authed(u))
      .expect(200);
    await ctx.prisma.product.update({
      where: { id: live.product.id },
      data: { status: 'ARCHIVED' },
    });
    expect(
      (await ctx.http().get('/api/v1/me/wishlist').set(authed(u))).body.data,
    ).toHaveLength(0);
  });

  it('removing never reveals whether a product exists or is unpublished: same 200 for all', async () => {
    const draft = await shop.fx.product({ status: 'DRAFT' });
    const u = await shop.customer();
    for (const slug of [draft.product.slug, 'no-such-product', 'another-ghost'])
      expect(
        (await ctx.http().delete(`/api/v1/me/wishlist/${slug}`).set(authed(u)))
          .status,
      ).toBe(200);
  });

  it('is capped at 200 items', async () => {
    const u = await shop.customer();
    const { product } = await shop.fx.product();
    const tag = randomBytes(4).toString('hex');
    await ctx.prisma.product.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        slug: `bulk-${tag}-${i}`,
        name: `Bulk ${i}`,
        status: 'PUBLISHED' as const,
      })),
    });
    const bulk = await ctx.prisma.product.findMany({
      where: { slug: { startsWith: `bulk-${tag}-` } },
      select: { id: true },
    });
    await ctx.prisma.wishlistItem.createMany({
      data: bulk.map((b) => ({ userId: u.userId, productId: b.id })),
    });
    const res = await ctx
      .http()
      .put(`/api/v1/me/wishlist/${product.slug}`)
      .set(authed(u));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WISHLIST_FULL');
  });
});

describe('compare', () => {
  it('compares 2-4 distinct published products with their attributes', async () => {
    const a = await shop.fx.product({ name: 'Cmp A' });
    const b = await shop.fx.product({ name: 'Cmp B' });
    const res = await ctx
      .http()
      .get(`/api/v1/catalog/compare?slugs=${a.product.slug},${b.product.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { slug: string }) => p.slug)).toEqual([
      a.product.slug,
      b.product.slug,
    ]);
  });

  it('refuses fewer than 2, more than 4, duplicates that collapse, unknown or unpublished products', async () => {
    const a = await shop.fx.product();
    const draft = await shop.fx.product({ status: 'DRAFT' });
    const get = (q: string) =>
      ctx.http().get(`/api/v1/catalog/compare?slugs=${q}`);
    expect((await get(a.product.slug)).status).toBe(400);
    expect((await get(`${a.product.slug},${a.product.slug}`)).status).toBe(400);
    expect((await get('a-b,b-c,c-d,d-e,e-f')).status).toBe(400);
    expect((await get(`${a.product.slug},no-such-product`)).status).toBe(404);
    expect((await get(`${a.product.slug},${draft.product.slug}`)).status).toBe(
      404,
    );
    expect((await ctx.http().get('/api/v1/catalog/compare')).status).toBe(400);
  });
});

describe('privacy', () => {
  it('deleting the account erases the customer’s reviews and wishlist; the data export includes them', async () => {
    const { product, u } = await buyer();
    await post(u, product.slug, goodReview()).then((r) =>
      expect(r.status).toBe(201),
    );
    await ctx
      .http()
      .put(`/api/v1/me/wishlist/${product.slug}`)
      .set(authed(u))
      .expect(200);
    const exp = await ctx
      .http()
      .post('/api/v1/me/export')
      .set(authed(u))
      .send({ password: u.password });
    expect(exp.status).toBe(200);
    expect(exp.body.data.reviews).toHaveLength(1);
    expect(exp.body.data.wishlist).toHaveLength(1);

    const del = await ctx
      .http()
      .delete('/api/v1/me')
      .set(authed(u))
      .send({ password: u.password });
    expect(del.status).toBe(200);
    expect(
      await ctx.prisma.productReview.count({ where: { userId: u.userId } }),
    ).toBe(0);
    expect(
      await ctx.prisma.wishlistItem.count({ where: { userId: u.userId } }),
    ).toBe(0);
  });
});
