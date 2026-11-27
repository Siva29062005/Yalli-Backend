import { Logger } from '@nestjs/common';
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
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
  shop = new Shop(ctx, s);
});
afterAll(() => ctx.close());

/** `query` is written like a query string for readability; it is sent as a JSON body. */
const search = (who: Session, query: string) =>
  ctx
    .http()
    .post('/api/v1/admin/customers/search')
    .set(authed(who))
    .send(Object.fromEntries(new URLSearchParams(query)));

describe('support customer lookup (customers.read)', () => {
  it('finds a customer by exact email, phone or order number; shows masked contact details, orders and returns', async () => {
    const support = await s.staff('CUSTOMER_SUPPORT');
    const u = await shop.customer();
    const { variant } = await shop.fx.product({ priceMinor: 25_000 });
    const order = await shop.order(u, [{ variantId: variant.id }]);
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: u.userId },
    });

    const byEmail = await search(
      support,
      `email=${encodeURIComponent(u.email.toUpperCase())}`,
    ).expect(200);
    expect(byEmail.body.data).toHaveLength(1);
    const hit = byEmail.body.data[0];
    expect(hit.id).toBe(u.userId);
    expect(hit.email).toMatch(/^.{1,2}•••@/);
    expect(hit.email).not.toBe(u.email);
    expect(JSON.stringify(hit)).not.toContain(u.email);
    expect(user.phoneE164).toBeTruthy();
    expect(JSON.stringify(hit)).not.toContain(user.phoneE164);
    const phoneQuery = `phone=${encodeURIComponent(user.phoneE164!)}`;
    // an UNVERIFIED number identifies nobody (someone else could have typed it)
    expect((await search(support, phoneQuery).expect(200)).body.data).toEqual(
      [],
    );
    await ctx.prisma.user.update({
      where: { id: u.userId },
      data: { phoneVerifiedAt: new Date() },
    });
    const byPhone = await search(support, phoneQuery).expect(200);
    expect(byPhone.body.data[0]?.id).toBe(u.userId);
    const byOrder = await search(
      support,
      `order=${order.orderNumber.toLowerCase()}`,
    ).expect(200);
    expect(byOrder.body.data[0]?.id).toBe(u.userId);

    const detail = await ctx
      .http()
      .get(`/api/v1/admin/customers/${u.userId}`)
      .set(authed(support))
      .expect(200);
    expect(detail.body.data.orders.map((o: { id: string }) => o.id)).toContain(
      order.id,
    );
    expect(detail.body.data.returns).toEqual([]);
    expect(JSON.stringify(detail.body.data)).not.toMatch(
      /passwordHash|argon2|tokenHash|secret/i,
    );
    // views and searches are audited with the staff member, never the searched value
    const audits = await ctx.prisma.auditLog.findMany({
      where: {
        actorId: support.userId,
        action: { in: ['customer.searched', 'customer.viewed'] },
      },
    });
    expect(audits.filter((a) => a.action === 'customer.viewed')).toHaveLength(
      1,
    );
    expect(JSON.stringify(audits)).not.toContain(u.email);
  });

  it('is exact-match only: partial text, two identifiers or none are refused; no match is an empty list', async () => {
    const support = await s.staff('CUSTOMER_SUPPORT');
    const u = await shop.customer();
    for (const bad of [
      '',
      `email=${encodeURIComponent(u.email.slice(0, 4))}`, // not an email
      `email=${encodeURIComponent(u.email)}&order=YL26-000001`,
      'q=priya',
      'order=a',
    ])
      expect((await search(support, bad)).status).toBe(400);
    expect(
      (await search(support, 'email=nobody%40example.test').expect(200)).body
        .data,
    ).toEqual([]);
  });

  it('never shows staff accounts, and needs customers.read (and a staff session)', async () => {
    const support = await s.staff('CUSTOMER_SUPPORT');
    const admin = await s.staff('ADMIN');
    const adminEmail = (
      await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })
    ).email;
    expect(
      (
        await search(support, `email=${encodeURIComponent(adminEmail)}`).expect(
          200,
        )
      ).body.data,
    ).toEqual([]);
    expect(
      (
        await ctx
          .http()
          .get(`/api/v1/admin/customers/${admin.userId}`)
          .set(authed(support))
      ).status,
    ).toBe(404);
    const customer = await shop.customer();
    for (const who of [
      await s.staff('PRODUCT_MANAGER'),
      await s.staff('FINANCE_MANAGER'),
      customer,
    ])
      expect(
        (
          await ctx
            .http()
            .get(`/api/v1/admin/customers/${customer.userId}`)
            .set(authed(who))
        ).status,
      ).toBe(403);
    await ctx
      .http()
      .post('/api/v1/admin/customers/search')
      .send({ order: 'YL26-0001' })
      .expect(401);
    // the old GET form does not exist (nothing searchable in a URL)
    expect(
      (
        await ctx
          .http()
          .get('/api/v1/admin/customers?order=YL26-0001')
          .set(authed(support))
      ).status,
    ).toBe(404);
  });
});
