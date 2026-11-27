import { Logger } from '@nestjs/common';
import {
  Scenario,
  authed,
  createTestApp,
  freshIp,
  totp,
  type Session,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
});
afterAll(() => ctx.close());

const address = (over: Record<string, unknown> = {}) => ({
  fullName: 'Asha Kumar',
  phone: '98765 43210',
  line1: 'Building No 3, Darga Complex',
  line2: 'Near Pallivasal',
  city: 'Madurai',
  state: 'Tamil Nadu',
  postalCode: '625002',
  ...over,
});
const addAddress = (u: Session, over: Record<string, unknown> = {}) =>
  ctx.http().post('/api/v1/me/addresses').set(authed(u)).send(address(over));

describe('profile', () => {
  it('updates allowed fields only', async () => {
    const u = await s.session();
    const res = await ctx
      .http()
      .patch('/api/v1/me')
      .set(authed(u))
      .send({ firstName: 'Priya', newsletterSubscribed: true })
      .expect(200);
    expect(res.body.data).toEqual({
      firstName: 'Priya',
      lastName: 'Kumar',
      newsletterSubscribed: true,
    });
    for (const bad of [
      { email: 'x@y.z' },
      { status: 'ACTIVE' },
      { roles: ['ADMIN'] },
      {},
    ]) {
      expect(
        (await ctx.http().patch('/api/v1/me').set(authed(u)).send(bad)).status,
      ).toBe(400);
    }
  });
});

describe('address book', () => {
  it('first address becomes the default; a new default unsets the old one; exactly one default at all times', async () => {
    const u = await s.session();
    const a = (await addAddress(u).expect(201)).body.data;
    expect(a).toMatchObject({
      isDefault: true,
      phoneE164: '+919876543210',
      countryCode: 'IN',
    });
    const b = (await addAddress(u, { line1: 'Second street' }).expect(201)).body
      .data;
    expect(b.isDefault).toBe(false);
    await ctx
      .http()
      .put(`/api/v1/me/addresses/${b.id}/default`)
      .set(authed(u))
      .expect(200);
    const list = (await ctx.http().get('/api/v1/me/addresses').set(authed(u)))
      .body.data as { id: string; isDefault: boolean }[];
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([b.id]);
  });

  it('cannot unset the default directly; deleting it promotes another address', async () => {
    const u = await s.session();
    const a = (await addAddress(u)).body.data;
    const b = (await addAddress(u, { line1: 'Other' })).body.data;
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/me/addresses/${a.id}`)
          .set(authed(u))
          .send({ isDefault: false })
      ).status,
    ).toBe(409);
    await ctx
      .http()
      .delete(`/api/v1/me/addresses/${a.id}`)
      .set(authed(u))
      .expect(200);
    const list = (await ctx.http().get('/api/v1/me/addresses').set(authed(u)))
      .body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: b.id, isDefault: true });
  });

  it('clears optional fields sent as empty/null but keeps omitted ones', async () => {
    const u = await s.session();
    const a = (
      await addAddress(u, { landmark: 'Near the temple', line2: 'Anna Nagar' })
    ).body.data;
    const updated = (
      await ctx
        .http()
        .patch(`/api/v1/me/addresses/${a.id}`)
        .set(authed(u))
        .send({ landmark: '', label: null })
        .expect(200)
    ).body.data;
    expect(updated.landmark).toBeNull();
    expect(updated.label).toBeNull();
    expect(updated.line2).toBe('Anna Nagar');
  });

  it('validates Indian addresses (state list, 6-digit PIN, phone) and rejects extra fields', async () => {
    const u = await s.session();
    expect((await addAddress(u, { postalCode: '012345' })).status).toBe(400);
    expect((await addAddress(u, { postalCode: '62500' })).status).toBe(400);
    expect((await addAddress(u, { state: 'Atlantis' })).status).toBe(400);
    expect((await addAddress(u, { phone: '123' })).status).toBe(400);
    expect(
      (await addAddress(u, { userId: '0190a7c0-0000-7000-8000-000000000000' }))
        .status,
    ).toBe(400);
    expect((await addAddress(u, { countryCode: 'US' })).status).toBe(400);
  });

  it('caps the number of addresses', async () => {
    const u = await s.session();
    for (let i = 0; i < 20; i++)
      await addAddress(u, { line1: `Street ${i}` }).expect(201);
    expect((await addAddress(u, { line1: 'One too many' })).status).toBe(409);
  });

  it("BOLA: another customer's address is invisible and untouchable on EVERY route (404, never 403)", async () => {
    const victim = await s.session();
    const attacker = await s.session();
    const target = (await addAddress(victim)).body.data;
    const routes = [
      ctx.http().get(`/api/v1/me/addresses/${target.id}`).set(authed(attacker)),
      ctx
        .http()
        .patch(`/api/v1/me/addresses/${target.id}`)
        .set(authed(attacker))
        .send({ city: 'Chennai' }),
      ctx
        .http()
        .put(`/api/v1/me/addresses/${target.id}/default`)
        .set(authed(attacker)),
      ctx
        .http()
        .delete(`/api/v1/me/addresses/${target.id}`)
        .set(authed(attacker)),
    ];
    for (const res of await Promise.all(routes)) expect(res.status).toBe(404);
    expect(
      (await ctx.http().get('/api/v1/me/addresses').set(authed(attacker))).body
        .data,
    ).toEqual([]);
    const intact = await ctx.prisma.address.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(intact).toMatchObject({
      city: 'Madurai',
      deletedAt: null,
      isDefault: true,
    });
  });

  it('requires authentication', async () => {
    expect(
      (
        await ctx
          .http()
          .get('/api/v1/me/addresses')
          .set('X-Forwarded-For', freshIp())
      ).status,
    ).toBe(401);
  });
});

describe('personal data export', () => {
  it("requires the password and returns the customer's own data without secrets", async () => {
    const u = await s.session();
    await addAddress(u);
    await ctx.prisma.contactMessage.create({
      data: {
        name: 'Me',
        email: u.email,
        topic: 'ORDER',
        message: 'Where is my parcel please?',
      },
    });
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/me/export')
          .set(authed(u))
          .send({ password: 'wrong-password-123' })
      ).status,
    ).toBe(401);
    const res = await ctx
      .http()
      .post('/api/v1/me/export')
      .set(authed(u))
      .send({ password: u.password })
      .expect(200);
    const data = res.body.data;
    expect(data.account.email).toBe(u.email);
    expect(data.addresses).toHaveLength(1);
    expect(data.consents[0]).toMatchObject({ type: 'PRIVACY_POLICY' });
    expect(data.securityEvents.length).toBeGreaterThan(0);
    // Contact-form messages sent from the account's address are personal data too
    expect(data.contactMessages).toEqual([
      expect.objectContaining({
        topic: 'ORDER',
        message: 'Where is my parcel please?',
      }),
    ]);
    expect(JSON.stringify(data)).not.toMatch(
      /argon2|passwordHash|tokenHash|secretEnc|codeHash/,
    );
  });

  it('requires the TOTP code too when MFA is on', async () => {
    const u = await s.session();
    const { secret } = await s.enableMfa(u);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/me/export')
          .set(authed(u))
          .send({ password: u.password })
      ).status,
    ).toBe(401);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/me/export')
          .set(authed(u))
          .send({ password: u.password, code: totp(secret, 0) })
      ).status,
    ).toBe(200);
  });
});

describe('account deletion (right to erasure)', () => {
  it("erases the contact-form messages sent from the account's address (and nobody else's)", async () => {
    const u = await s.session();
    const other = `other.${Date.now()}@example.test`;
    for (const email of [u.email, other])
      await ctx.prisma.contactMessage.create({
        data: {
          name: 'Someone',
          email,
          topic: 'OTHER',
          message: 'A question about a product.',
        },
      });
    await ctx
      .http()
      .delete('/api/v1/me')
      .set(authed(u))
      .send({ password: u.password })
      .expect(200);
    expect(
      await ctx.prisma.contactMessage.count({ where: { email: u.email } }),
    ).toBe(0);
    expect(
      await ctx.prisma.contactMessage.count({ where: { email: other } }),
    ).toBe(1);
  });

  it('anonymises personal data, ends every session, and the email can be used for a brand-new account', async () => {
    const u = await s.session();
    await addAddress(u);
    expect(
      (
        await ctx
          .http()
          .delete('/api/v1/me')
          .set(authed(u))
          .send({ password: 'wrong-password-123' })
      ).status,
    ).toBe(401);
    await ctx
      .http()
      .delete('/api/v1/me')
      .set(authed(u))
      .send({ password: u.password })
      .expect(200);

    expect((await ctx.http().get('/api/v1/me').set(authed(u))).status).toBe(
      401,
    );
    expect((await s.login(u.email, u.password)).status).toBe(401);

    const row = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: u.userId },
      include: { customer: true, addresses: true },
    });
    expect(row).toMatchObject({
      status: 'DELETED',
      phoneE164: null,
      mfaEnabled: false,
    });
    expect(row.email).toBe(`deleted+${u.userId}@deleted.invalid`);
    expect(row.passwordHash.startsWith('$argon2')).toBe(false);
    expect(row.customer).toMatchObject({
      firstName: 'Deleted',
      lastName: 'User',
    });
    expect(row.addresses).toHaveLength(0);
    // Legal evidence is retained.
    expect(
      await ctx.prisma.consent.count({ where: { userId: u.userId } }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { actorId: u.userId, action: 'customer.account.deleted' },
      }),
    ).toBe(1);

    const again = await s.registerUser({ email: u.email });
    expect(again.res.status).toBe(202);
    expect(ctx.notifier.last('EMAIL_VERIFICATION', u.email)).toBeDefined();
  });

  it('staff accounts cannot self-delete', async () => {
    const st = await s.staff('ORDER_MANAGER');
    const res = await ctx
      .http()
      .delete('/api/v1/me')
      .set(authed(st))
      .send({ password: st.password });
    expect(res.status).toBe(403);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: st.userId } }))
        .status,
    ).toBe('ACTIVE');
  });
});
