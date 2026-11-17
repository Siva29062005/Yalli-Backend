import { Logger } from '@nestjs/common';
import {
  Scenario,
  STRONG_PASSWORD,
  createTestApp,
  freshIp,
  authed,
  uniqueEmail,
  uniquePhone,
  type TestContext,
} from '../support/test-app.js';

describe('registration', () => {
  let ctx: TestContext;
  let s: Scenario;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    ctx = await createTestApp();
    s = new Scenario(ctx);
  });
  afterAll(() => ctx.close());

  it('creates a PENDING account, blocks login until the email is verified, then activates it', async () => {
    const { res, email, password, ip } = await s.registerUser();
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, data: null });

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { emailNormalized: email },
    });
    expect(user.status).toBe('PENDING_VERIFICATION');

    const blocked = await s.login(email, password, ip);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = ctx.notifier.last('EMAIL_VERIFICATION', email)!.token;
    await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ token })
      .expect(200);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .status,
    ).toBe('ACTIVE');
    await s.login(email, password, ip).then((r) => expect(r.status).toBe(200));
  });

  it('verification tokens are single-use', async () => {
    const { email, ip } = await s.registerUser();
    const token = ctx.notifier.last('EMAIL_VERIFICATION', email)!.token;
    await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ token })
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ token })
      .expect(400);
  });

  it('expired verification tokens are rejected', async () => {
    const { email, ip } = await s.registerUser();
    const token = ctx.notifier.last('EMAIL_VERIFICATION', email)!.token;
    await ctx.prisma.verificationToken.updateMany({
      where: { target: email },
      data: {
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 2000),
      },
    });
    await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ token })
      .expect(400);
  });

  it('does not reveal whether an email is registered (identical response) and tells only the real owner', async () => {
    const first = await s.registerUser();
    const dup = await s.registerUser({ email: first.email });
    const fresh = await s.registerUser();
    expect(dup.res.status).toBe(first.res.status);
    expect(dup.res.body.message).toBe(fresh.res.body.message);
    expect(Object.keys(dup.res.body).sort()).toEqual(
      Object.keys(fresh.res.body).sort(),
    );
    expect(
      await ctx.prisma.user.count({ where: { emailNormalized: first.email } }),
    ).toBe(1);
    expect(
      ctx.notifier.last('ACCOUNT_ALREADY_EXISTS', first.email),
    ).toBeDefined();
  });

  it('treats differently-cased addresses as the same account', async () => {
    const first = await s.registerUser({
      email: `Mixed.Case.${Date.now()}@Example.com`,
    });
    await s.registerUser({ email: first.email.toUpperCase() });
    expect(
      await ctx.prisma.user.count({
        where: { emailNormalized: first.email.toLowerCase() },
      }),
    ).toBe(1);
  });

  it('stores an Argon2id hash, never the password, and gives only the CUSTOMER role', async () => {
    const { email, password } = await s.registerUser();
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { emailNormalized: email },
      include: {
        roles: { include: { role: true } },
        consents: true,
        customer: true,
      },
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(user.passwordHash).not.toContain(password);
    expect(user.roles.map((r) => r.role.name)).toEqual(['CUSTOMER']);
    expect(user.consents[0]).toMatchObject({
      type: 'PRIVACY_POLICY',
      version: 'v1',
    });
    expect(user.customer).toMatchObject({
      firstName: 'Asha',
      lastName: 'Kumar',
    });
  });

  it.each([
    ['too short', 'Sh0rt!pw', /at least 12/],
    ['contains the email name', 'ashakumar-secure-9981', /email name/],
    ['too repetitive', 'aaaaaaaaaaaaaaaa', /repetitive/],
    ['commonly used', 'password-is-not-secret', /commonly used/],
  ])(
    'rejects a weak password (%s) with path+message only',
    async (_n, password, message) => {
      const email = `ashakumar.${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
      const { res } = await s.registerUser({ email, password });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toMatch(message);
      expect(JSON.stringify(res.body)).not.toContain(password);
    },
  );

  it('rejects passwords found in a breach corpus', async () => {
    const { res } = await s.registerUser({
      password: 'Breached-Password-2024!',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/data breach/);
  });

  it('mass assignment: privileged fields in the body are rejected, not ignored', async () => {
    for (const extra of [
      { role: 'SUPER_ADMIN' },
      { roles: ['ADMIN'] },
      { status: 'ACTIVE' },
      { emailVerified: true },
      { mfaEnabled: true },
      { id: 'x' },
    ]) {
      const res = await ctx
        .http()
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', freshIp())
        .send({
          firstName: 'A',
          lastName: 'B',
          email: uniqueEmail(),
          phone: uniquePhone(),
          password: STRONG_PASSWORD,
          acceptPrivacyPolicy: true,
          ...extra,
        });
      expect(res.status).toBe(400);
    }
  });

  it('requires accepting the privacy policy and a valid phone number', async () => {
    const base = { firstName: 'A', lastName: 'B', password: STRONG_PASSWORD };
    const ip = freshIp();
    const post = (b: object) =>
      ctx
        .http()
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', ip)
        .send(b);
    expect(
      (
        await post({
          ...base,
          email: uniqueEmail(),
          phone: uniquePhone(),
          acceptPrivacyPolicy: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...base,
          email: uniqueEmail(),
          phone: '12345',
          acceptPrivacyPolicy: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...base,
          email: 'not-an-email',
          phone: uniquePhone(),
          acceptPrivacyPolicy: true,
        })
      ).status,
    ).toBe(400);
  });

  it('normalises phone numbers to E.164', async () => {
    const { email } = await s.registerUser({ phone: '98765 43210' });
    expect(
      (
        await ctx.prisma.user.findUniqueOrThrow({
          where: { emailNormalized: email },
        })
      ).phoneE164,
    ).toBe('+919876543210');
  });
});

describe('login', () => {
  let ctx: TestContext;
  let s: Scenario;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    ctx = await createTestApp();
    s = new Scenario(ctx);
  });
  afterAll(() => ctx.close());

  it('returns short-lived tokens and /me exposes no secrets', async () => {
    const session = await s.session();
    const me = await ctx.http().get('/api/v1/me').set(authed(session));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({
      email: session.email,
      emailVerified: true,
      mfaEnabled: false,
      roles: ['CUSTOMER'],
    });
    const text = JSON.stringify(me.body);
    expect(text).not.toMatch(/passwordHash|argon2|refresh|secret/i);
  });

  it('gives identical responses for unknown email and wrong password (no enumeration)', async () => {
    const { email, password } = await s.verifiedUser();
    const wrong = await s.login(email, `${password}x`);
    const unknown = await s.login(uniqueEmail('ghost'), password);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('locks the account after repeated failures, and a locked account refuses even the CORRECT password identically', async () => {
    const { email, password } = await s.verifiedUser();
    for (let i = 0; i < 5; i++)
      await s.login(email, 'definitely-wrong-password', freshIp());
    const locked = await s.login(email, password, freshIp());
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('UNAUTHORIZED');
    const row = await ctx.prisma.user.findUniqueOrThrow({
      where: { emailNormalized: email },
    });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(
      Date.now() + 14 * 60_000,
    );
    expect(ctx.notifier.last('ACCOUNT_LOCKED', email)).toMatchObject({
      minutes: 15,
    });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.account.locked', actorId: row.id },
      }),
    ).toBe(1);
  });

  it('an anonymous attacker can never lock an account for more than an hour, however long they keep guessing', async () => {
    const { email } = await s.verifiedUser();
    await ctx.prisma.user.update({
      where: { emailNormalized: email },
      data: { failedLoginCount: 49, lockedUntil: null }, // 50th failure would be 15 * 2^9 minutes uncapped
    });
    await s.login(email, 'definitely-wrong-password', freshIp());
    const row = await ctx.prisma.user.findUniqueOrThrow({
      where: { emailNormalized: email },
    });
    expect(row.lockedUntil!.getTime()).toBeLessThanOrEqual(
      Date.now() + 60 * 60_000 + 5_000,
    );
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(
      Date.now() + 59 * 60_000,
    );
    expect(ctx.notifier.last('ACCOUNT_LOCKED', email)).toMatchObject({
      minutes: 60,
    });
  });

  it('recovers once the lock expires and resets the failure counter', async () => {
    const { email, password } = await s.verifiedUser();
    for (let i = 0; i < 5; i++)
      await s.login(email, 'wrong-wrong-wrong-1', freshIp());
    await ctx.prisma.user.update({
      where: { emailNormalized: email },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await s.login(email, password, freshIp())).status).toBe(200);
    expect(
      (
        await ctx.prisma.user.findUniqueOrThrow({
          where: { emailNormalized: email },
        })
      ).failedLoginCount,
    ).toBe(0);
  });

  it('escalates lockouts: the second lock is longer', async () => {
    const { email } = await s.verifiedUser();
    for (let i = 0; i < 5; i++)
      await s.login(email, 'wrong-wrong-wrong-1', freshIp());
    await ctx.prisma.user.update({
      where: { emailNormalized: email },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    for (let i = 0; i < 5; i++)
      await s.login(email, 'wrong-wrong-wrong-1', freshIp());
    expect(ctx.notifier.last('ACCOUNT_LOCKED', email)).toMatchObject({
      minutes: 30,
    });
  });

  it('throttles credential stuffing against one account spread across many IPs (per-account limit)', async () => {
    const target = uniqueEmail('victim');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push(
        (await s.login(target, 'guess-number-' + i, freshIp())).status,
      );
    expect(statuses.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('throttles a single IP across many accounts (per-IP limit) and sets Retry-After', async () => {
    const ip = freshIp();
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 32; i++) {
      const r = await s.login(uniqueEmail('spray'), 'whatever-password-1', ip);
      last = r.status;
      retryAfter = r.headers['retry-after'];
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('alerts on a login from a new device but not on the very first login', async () => {
    const { email, password } = await s.verifiedUser();
    ctx.notifier.clear();
    await s.login(email, password, freshIp(), { 'User-Agent': 'Browser/1' });
    expect(ctx.notifier.last('NEW_DEVICE_LOGIN', email)).toBeUndefined();
    await s.login(email, password, freshIp(), { 'User-Agent': 'Browser/1' });
    expect(ctx.notifier.last('NEW_DEVICE_LOGIN', email)).toBeUndefined();
    await s.login(email, password, freshIp(), {
      'User-Agent': 'SomethingElse/9',
    });
    expect(ctx.notifier.last('NEW_DEVICE_LOGIN', email)).toBeDefined();
  });

  it('a suspended account cannot sign in (after proving the password)', async () => {
    const { email, password } = await s.verifiedUser();
    await ctx.prisma.user.update({
      where: { emailNormalized: email },
      data: { status: 'SUSPENDED' },
    });
    const res = await s.login(email, password);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await s.login(email, 'wrong-password-123')).status).toBe(401);
  });

  it('records login outcomes in the audit trail without credentials', async () => {
    const { email, password } = await s.verifiedUser();
    await s.login(email, 'wrong-password-123');
    await s.login(email, password);
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { emailNormalized: email },
    });
    const rows = await ctx.prisma.auditLog.findMany({
      where: { actorId: user.id },
    });
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['auth.login.failure', 'auth.login.success']),
    );
    expect(JSON.stringify(rows)).not.toContain(password);
  });
});
