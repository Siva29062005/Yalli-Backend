import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { CouponService } from '../../src/modules/coupons/coupon.service.js';
import {
  CatalogFixture,
  Scenario,
  authed,
  createTestApp,
  freshIp,
  type Session,
  type TestContext,
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

/** A guest client with a stable IP and (once issued) a cart token. */
class Guest {
  ip = freshIp();
  token: string | undefined;
  private h() {
    return {
      'X-Forwarded-For': this.ip,
      ...(this.token ? { 'X-Cart-Token': this.token } : {}),
    };
  }
  async add(variantId: string, quantity = 1) {
    const res = await ctx
      .http()
      .post('/api/v1/cart/items')
      .set(this.h())
      .send({ variantId, quantity });
    if (res.body.data?.cartToken) this.token = res.body.data.cartToken;
    return res;
  }
  get = () => ctx.http().get('/api/v1/cart').set(this.h());
  patch = (variantId: string, quantity: number) =>
    ctx
      .http()
      .patch(`/api/v1/cart/items/${variantId}`)
      .set(this.h())
      .send({ quantity });
  coupon = (code: string) =>
    ctx.http().post('/api/v1/cart/coupon').set(this.h()).send({ code });
}
const userCart = (u: Session) => ({
  add: (variantId: string, quantity = 1) =>
    ctx
      .http()
      .post('/api/v1/cart/items')
      .set(authed(u))
      .send({ variantId, quantity }),
  get: () => ctx.http().get('/api/v1/cart').set(authed(u)),
  coupon: (code: string) =>
    ctx
      .http()
      .post('/api/v1/cart/coupon')
      .set({ ...authed(u), 'X-Forwarded-For': freshIp() })
      .send({ code }),
});
const code = (p = 'T') => `${p}${randomBytes(4).toString('hex').toUpperCase()}`;
const makeCoupon = (data: Record<string, unknown>) =>
  ctx.prisma.coupon.create({
    data: {
      code: code(),
      discountType: 'PERCENTAGE',
      percentBps: 1000,
      ...data,
    } as never,
  });

describe('guest cart', () => {
  it('issues a 256-bit token on first add and prices everything server-side (GST-inclusive)', async () => {
    const { variant } = await fx.product({ priceMinor: 59_000 });
    const g = new Guest();
    const res = await g.add(variant.id, 2);
    expect(res.status).toBe(201);
    expect(g.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.totals).toEqual({
      subtotalMinor: 118_000,
      discountMinor: 0,
      shippingMinor: 0,
      gstIncludedMinor: 18_000,
      totalMinor: 118_000,
      currency: 'INR',
    });
    // the token is only revealed once
    expect((await g.get()).body.data.cartToken).toBeUndefined();
    // stored hashed
    expect(
      JSON.stringify(
        await ctx.prisma.cart.findMany({ where: { userId: null } }),
      ),
    ).not.toContain(g.token);
  });

  it('carts are isolated: no token or another token sees nothing; a malformed token is a 400', async () => {
    const { variant } = await fx.product();
    const a = new Guest();
    await a.add(variant.id);
    const b = new Guest();
    expect((await b.get()).body.data.items).toEqual([]);
    b.token = randomBytes(32).toString('base64url');
    expect((await b.get()).body.data.items).toEqual([]);
    expect(
      (await ctx.http().get('/api/v1/cart').set('X-Cart-Token', 'not-a-token'))
        .status,
    ).toBe(400);
  });

  it('never accepts client prices or totals (unknown fields are rejected)', async () => {
    const { variant } = await fx.product({ priceMinor: 59_000 });
    for (const body of [
      { variantId: variant.id, quantity: 1, unitPriceMinor: 1 },
      { variantId: variant.id, quantity: 1, totalMinor: 1 },
      { variantId: variant.id, quantity: 1, discount: 100 },
    ]) {
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/cart/items')
            .set('X-Forwarded-For', freshIp())
            .send(body)
        ).status,
      ).toBe(400);
    }
  });

  it('enforces quantity limits and current stock', async () => {
    const { variant } = await fx.product({ stock: 3 });
    const g = new Guest();
    expect((await g.add(variant.id, 11)).status).toBe(400);
    expect((await g.add(variant.id, 0)).status).toBe(400);
    expect((await g.add(variant.id, 4)).body.error.code).toBe(
      'INSUFFICIENT_STOCK',
    );
    expect((await g.add(variant.id, 3)).status).toBe(201);
    expect((await g.add(variant.id, 1)).body.error.code).toBe(
      'INSUFFICIENT_STOCK',
    );
    const plenty = await fx.product({ stock: 100 });
    const h = new Guest();
    await h.add(plenty.variant.id, 8);
    expect((await h.add(plenty.variant.id, 3)).body.error.code).toBe(
      'QUANTITY_LIMIT',
    );
  });

  it('concurrent adds of the same item cannot push a line past the limits', async () => {
    const { variant } = await fx.product({ stock: 100 });
    const g = new Guest();
    await g.add(variant.id, 1);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => g.add(variant.id, 2)),
    );
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    const qty = (await g.get()).body.data.items[0].quantity;
    expect(qty).toBeLessThanOrEqual(10);
    expect(qty).toBe(9); // 1 + 4 successful adds of 2
  });

  it('re-prices live: a price change after adding is reflected; unpublished items are flagged and excluded', async () => {
    const a = await fx.product({ priceMinor: 10_000 });
    const b = await fx.product({ priceMinor: 20_000 });
    const g = new Guest();
    await g.add(a.variant.id);
    await g.add(b.variant.id);
    await ctx.prisma.productVariant.update({
      where: { id: a.variant.id },
      data: { priceMinor: 15_000 },
    });
    await ctx.prisma.product.update({
      where: { id: b.product.id },
      data: { status: 'DRAFT' },
    });
    const view = (await g.get()).body.data;
    expect(
      view.items.find(
        (i: { variantId: string }) => i.variantId === a.variant.id,
      ),
    ).toMatchObject({ unitPriceMinor: 15_000, purchasable: true });
    expect(
      view.items.find(
        (i: { variantId: string }) => i.variantId === b.variant.id,
      ),
    ).toMatchObject({
      purchasable: false,
      issue: 'UNAVAILABLE',
      lineTotalMinor: 0,
    });
    expect(view.totals.totalMinor).toBe(15_000);
    expect(view.itemCount).toBe(1);
  });

  it('cannot add unpublished, deleted or unknown items', async () => {
    const draft = await fx.product({ status: 'DRAFT' });
    const g = new Guest();
    expect((await g.add(draft.variant.id)).status).toBe(404);
    expect((await g.add(randomUUID())).status).toBe(404);
  });

  it('update and remove work only on lines in YOUR cart', async () => {
    const { variant } = await fx.product();
    const g = new Guest();
    await g.add(variant.id, 1);
    expect((await g.patch(variant.id, 3)).body.data.items[0].quantity).toBe(3);
    const other = new Guest();
    await other.add((await fx.product()).variant.id);
    expect((await other.patch(variant.id, 5)).status).toBe(404);
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/cart/items/${variant.id}`)
          .set({ 'X-Cart-Token': other.token!, 'X-Forwarded-For': other.ip })
      ).status,
    ).toBe(404);
    expect((await g.get()).body.data.items[0].quantity).toBe(3);
  });
});

describe('signed-in cart and merge', () => {
  it('an invalid bearer token is refused, never downgraded to a guest cart', async () => {
    expect(
      (
        await ctx.http().get('/api/v1/cart').set({
          Authorization: 'Bearer garbage-token-value-xxxxxxxx',
          'X-Forwarded-For': freshIp(),
        })
      ).status,
    ).toBe(401);
  });

  it("a signed-in user only ever sees their own cart, even when sending someone else's guest token", async () => {
    const { variant } = await fx.product();
    const g = new Guest();
    await g.add(variant.id);
    const u = await s.session();
    const res = await ctx
      .http()
      .get('/api/v1/cart')
      .set({ ...authed(u), 'X-Cart-Token': g.token! });
    expect(res.body.data.items).toEqual([]);
  });

  it('merges the guest cart on login (quantities summed and capped), then the guest cart is gone', async () => {
    const a = await fx.product({ stock: 50 });
    const b = await fx.product({ stock: 50 });
    const u = await s.session();
    await userCart(u).add(a.variant.id, 7);
    const g = new Guest();
    await g.add(a.variant.id, 6);
    await g.add(b.variant.id, 2);
    const merged = await ctx
      .http()
      .post('/api/v1/cart/merge')
      .set({ ...authed(u), 'X-Cart-Token': g.token! })
      .expect(200);
    const qty = Object.fromEntries(
      merged.body.data.items.map(
        (i: { variantId: string; quantity: number }) => [
          i.variantId,
          i.quantity,
        ],
      ),
    );
    expect(qty).toEqual({ [a.variant.id]: 10, [b.variant.id]: 2 });
    expect((await g.get()).body.data.items).toEqual([]); // the guest token no longer opens anything
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/cart/merge')
          .set('X-Cart-Token', g.token!)
          .set('X-Forwarded-For', freshIp())
      ).status,
    ).toBe(401);
  });
});

describe('merge respects the line limit', () => {
  it('a 49-line cart merged with 3 new guest lines ends at exactly 50 lines', async () => {
    const products = [];
    for (let i = 0; i < 52; i++) products.push(await fx.product({ stock: 5 }));
    const u = await s.session();
    await userCart(u).add(products[0]!.variant.id, 1).expect(201);
    const cart = await ctx.prisma.cart.findFirstOrThrow({
      where: { userId: u.userId },
    });
    await ctx.prisma.cartItem.createMany({
      data: products.slice(1, 49).map((p) => ({
        cartId: cart.id,
        variantId: p.variant.id,
        quantity: 1,
      })),
    });
    expect(
      await ctx.prisma.cartItem.count({ where: { cartId: cart.id } }),
    ).toBe(49);
    const g = new Guest();
    for (const p of products.slice(49, 52)) await g.add(p.variant.id, 1);
    await ctx
      .http()
      .post('/api/v1/cart/merge')
      .set({ ...authed(u), 'X-Cart-Token': g.token! })
      .expect(200);
    expect(
      await ctx.prisma.cartItem.count({ where: { cartId: cart.id } }),
    ).toBe(50);
  });
});

describe('coupons in the cart', () => {
  it('applies a valid percentage coupon (case-insensitive code) with an exact discount', async () => {
    const { variant } = await fx.product({ priceMinor: 12_345 });
    const c = await makeCoupon({ percentBps: 1000 });
    const g = new Guest();
    await g.add(variant.id, 1);
    const res = await g.coupon(c.code.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.body.data.coupon).toEqual({
      code: c.code,
      discountMinor: 1_234,
    });
    expect(res.body.data.totals.totalMinor).toBe(11_111);
  });

  it('unknown, inactive, expired and future coupons are indistinguishable (no code enumeration)', async () => {
    const { variant } = await fx.product();
    const inactive = await makeCoupon({ isActive: false });
    const expired = await makeCoupon({
      startsAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    const future = await makeCoupon({
      startsAt: new Date(Date.now() + 86_400_000),
    });
    const bodies = [];
    for (const k of ['NOSUCHCODE1', inactive.code, expired.code, future.code]) {
      const g = new Guest();
      await g.add(variant.id);
      const r = await g.coupon(k);
      expect(r.status).toBe(400);
      bodies.push(JSON.stringify({ m: r.body.message, c: r.body.error.code }));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('explains minimum-cart and scope rejections, and refuses exhausted coupons', async () => {
    const { product, variant } = await fx.product({ priceMinor: 10_000 });
    const g = new Guest();
    await g.add(variant.id);
    expect(
      (await g.coupon((await makeCoupon({ minCartMinor: 50_000 })).code)).body
        .error.code,
    ).toBe('COUPON_MIN_CART_VALUE');
    const other = await fx.product();
    const scoped = await ctx.prisma.coupon.create({
      data: {
        code: code('P'),
        discountType: 'FIXED_AMOUNT',
        amountMinor: 500,
        scope: 'PRODUCTS',
        products: { create: [{ productId: other.product.id }] },
      },
    });
    expect((await g.coupon(scoped.code)).body.error.code).toBe(
      'COUPON_NO_ELIGIBLE_ITEMS',
    );
    const done = await makeCoupon({ maxRedemptions: 1, redeemedCount: 1 });
    expect((await g.coupon(done.code)).body.error.code).toBe(
      'COUPON_UNAVAILABLE',
    );
    // nothing stuck to the cart after a rejection
    expect((await g.get()).body.data.coupon).toBeNull();
    expect(product.id).toBeTruthy();
  });

  it('a coupon that stops being valid after it was applied stops discounting (re-validated on every view)', async () => {
    const { variant } = await fx.product({ priceMinor: 10_000 });
    const c = await makeCoupon({ percentBps: 5000 });
    const g = new Guest();
    await g.add(variant.id);
    expect((await g.coupon(c.code)).body.data.totals.totalMinor).toBe(5_000);
    await ctx.prisma.coupon.update({
      where: { id: c.id },
      data: { isActive: false },
    });
    const view = (await g.get()).body.data;
    expect(view.totals.totalMinor).toBe(10_000);
    expect(view.couponError).toBe('INVALID');
  });

  it('per-customer limits apply to signed-in users', async () => {
    const { variant } = await fx.product();
    const c = await makeCoupon({ perCustomerLimit: 1 });
    const u = await s.session();
    await userCart(u).add(variant.id);
    await ctx.prisma.couponRedemption.create({
      data: {
        couponId: c.id,
        userId: u.userId,
        referenceType: 'ORDER',
        referenceId: randomUUID(),
        discountMinor: 100,
      },
    });
    expect((await userCart(u).coupon(c.code)).body.error.code).toBe(
      'COUPON_CUSTOMER_LIMIT',
    );
  });

  it('coupon guessing is rate-limited', async () => {
    const { variant } = await fx.product();
    const g = new Guest();
    await g.add(variant.id);
    const statuses = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await g.coupon(`GUESS${i}XYZ`)).status);
    expect(statuses.slice(0, 10).every((x) => x === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('coupon redemption under concurrency (checkout path)', () => {
  const redeem = (
    couponId: string,
    userId: string,
    referenceId = randomUUID(),
  ) =>
    ctx.prisma.$transaction((tx) =>
      ctx.app.get(CouponService).redeemInTx(tx, {
        couponId,
        userId,
        referenceType: 'ORDER',
        referenceId,
        discountMinor: 100,
      }),
    );

  it('a coupon limited to 3 uses is redeemed exactly 3 times by 12 concurrent customers', async () => {
    const c = await makeCoupon({ maxRedemptions: 3 });
    const users = await Promise.all(
      Array.from({ length: 12 }, () => s.session()),
    );
    const results = await Promise.allSettled(
      users.map((u) => redeem(c.id, u.userId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(
      (await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: c.id } }))
        .redeemedCount,
    ).toBe(3);
    expect(
      await ctx.prisma.couponRedemption.count({ where: { couponId: c.id } }),
    ).toBe(3);
  });

  it('a once-per-customer coupon is redeemed once even when one customer fires 6 parallel checkouts', async () => {
    const c = await makeCoupon({ perCustomerLimit: 1 });
    const u = await s.session();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => redeem(c.id, u.userId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await ctx.prisma.couponRedemption.count({
        where: { couponId: c.id, userId: u.userId },
      }),
    ).toBe(1);
  });

  it('is idempotent per order reference', async () => {
    const c = await makeCoupon({ maxRedemptions: 5 });
    const u = await s.session();
    const ref = randomUUID();
    expect(await redeem(c.id, u.userId, ref)).toBe('redeemed');
    expect(await redeem(c.id, u.userId, ref)).toBe('already-redeemed');
    expect(
      (await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: c.id } }))
        .redeemedCount,
    ).toBe(1);
  });
});

describe('coupon administration', () => {
  it('a FINANCE_MANAGER manages coupons; codes are normalised; support staff are refused', async () => {
    const fm = await s.staff('FINANCE_MANAGER');
    const res = await ctx
      .http()
      .post('/api/v1/admin/coupons')
      .set(authed(fm))
      .send({
        code: `welcome-${randomBytes(2).toString('hex')}`,
        discountType: 'PERCENTAGE',
        percentBps: 1500,
        maxDiscountMinor: 20_000,
        perCustomerLimit: 1,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^WELCOME-/);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'coupon.created', actorId: fm.userId },
      }),
    ).toBe(1);
    const cs = await s.staff('CUSTOMER_SUPPORT');
    expect(
      (
        await ctx.http().post('/api/v1/admin/coupons').set(authed(cs)).send({
          code: 'NOPE123',
          discountType: 'FIXED_AMOUNT',
          amountMinor: 100,
        })
      ).status,
    ).toBe(403);
  });

  it('validates coupon definitions', async () => {
    const fm = await s.staff('FINANCE_MANAGER');
    const post = (b: object) =>
      ctx
        .http()
        .post('/api/v1/admin/coupons')
        .set(authed(fm))
        .send({ code: code('V'), ...b });
    expect(
      (
        await post({
          discountType: 'PERCENTAGE',
          percentBps: 1000,
          amountMinor: 100,
        })
      ).status,
    ).toBe(400);
    expect((await post({ discountType: 'FIXED_AMOUNT' })).status).toBe(400);
    expect(
      (await post({ discountType: 'PERCENTAGE', percentBps: 10_001 })).status,
    ).toBe(400);
    expect(
      (
        await post({
          discountType: 'PERCENTAGE',
          percentBps: 1000,
          scope: 'PRODUCTS',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          discountType: 'PERCENTAGE',
          percentBps: 1000,
          redeemedCount: 0,
        })
      ).status,
    ).toBe(400);
  });

  it('a usage limit cannot be lowered below the redemptions already made', async () => {
    const fm = await s.staff('FINANCE_MANAGER');
    const c = await makeCoupon({ maxRedemptions: 10, redeemedCount: 4 });
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/coupons/${c.id}`)
          .set(authed(fm))
          .send({ maxRedemptions: 3 })
      ).status,
    ).toBe(409);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/coupons/${c.id}`)
          .set(authed(fm))
          .send({ maxRedemptions: 5 })
      ).status,
    ).toBe(200);
  });
});
