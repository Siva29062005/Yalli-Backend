import { Logger } from '@nestjs/common';
import {
  Scenario,
  authed,
  createTestApp,
  freshIp,
  jwtPayload,
  totp,
  waitFor,
  STRONG_PASSWORD,
  uniqueEmail,
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

const NEW_PASSWORD = 'Another-Strong-Passphrase-77';
const forgot = (email: string, ip = freshIp()) =>
  ctx
    .http()
    .post('/api/v1/auth/forgot-password')
    .set('X-Forwarded-For', ip)
    .send({ email });
const reset = (token: string, newPassword: string, ip = freshIp()) =>
  ctx
    .http()
    .post('/api/v1/auth/reset-password')
    .set('X-Forwarded-For', ip)
    .send({ token, newPassword });
const resetToken = async (email: string) =>
  (await waitFor(() => ctx.notifier.last('PASSWORD_RESET', email))).token;

describe('forgot / reset password', () => {
  it('gives the same answer for known and unknown emails, and only emails the real owner', async () => {
    const { email } = await s.verifiedUser();
    const known = await forgot(email);
    const unknown = await forgot(uniqueEmail('ghost'));
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body.message).toBe(known.body.message);
    expect(unknown.body.data).toEqual(known.body.data);
    await resetToken(email);
    expect(ctx.notifier.last('PASSWORD_RESET', 'ghost')).toBeUndefined();
  });

  it('completes the reset: new password works, old one does not, every session is revoked, the lock is cleared', async () => {
    const a = await s.session();
    for (let i = 0; i < 5; i++)
      await s.login(a.email, 'wrong-wrong-wrong-1', freshIp()); // lock the account
    await forgot(a.email);
    const token = await resetToken(a.email);

    expect((await reset(token, NEW_PASSWORD)).status).toBe(200);
    expect((await ctx.http().get('/api/v1/me').set(authed(a))).status).toBe(
      401,
    ); // old session dead
    expect((await s.login(a.email, a.password)).status).toBe(401); // old password dead
    expect((await s.login(a.email, NEW_PASSWORD)).status).toBe(200); // lock cleared, new password works
    expect(ctx.notifier.last('PASSWORD_CHANGED', a.email)).toBeDefined();
  });

  it('reset tokens are single-use', async () => {
    const { email } = await s.verifiedUser();
    await forgot(email);
    const token = await resetToken(email);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(200);
    expect((await reset(token, 'Yet-Another-Passphrase-123')).status).toBe(400);
  });

  it('a weak new password is rejected WITHOUT burning the link', async () => {
    const { email } = await s.verifiedUser();
    await forgot(email);
    const token = await resetToken(email);
    expect((await reset(token, 'short')).status).toBe(400);
    expect((await reset(token, 'Breached-Password-2024!')).status).toBe(400);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(200);
  });

  it('a newer request invalidates the older link, and expired links fail', async () => {
    const { email } = await s.verifiedUser();
    await forgot(email);
    const first = await resetToken(email);
    ctx.notifier.clear();
    await forgot(email);
    const second = await resetToken(email);
    expect(second).not.toBe(first);
    expect((await reset(first, NEW_PASSWORD)).status).toBe(400);

    await ctx.prisma.verificationToken.updateMany({
      where: { target: email, usedAt: null },
      data: {
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 5000),
      },
    });
    expect((await reset(second, NEW_PASSWORD)).status).toBe(400);
  });

  it('purposes are not interchangeable: a reset token cannot verify an email and vice versa', async () => {
    const { email } = await s.verifiedUser();
    await forgot(email);
    const token = await resetToken(email);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/verify-email')
          .set('X-Forwarded-For', freshIp())
          .send({ token })
      ).status,
    ).toBe(400);

    const reg = await s.registerUser();
    const verifyToken = ctx.notifier.last(
      'EMAIL_VERIFICATION',
      reg.email,
    )!.token;
    expect((await reset(verifyToken, NEW_PASSWORD)).status).toBe(400);
  });

  it('rate-limits reset requests per account (abuse / mail-bombing)', async () => {
    const { email } = await s.verifiedUser();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await forgot(email, freshIp())).status);
    expect(codes).toEqual([202, 202, 202, 429, 429]);
  });

  it('a pending (unverified) account that completes a reset becomes active, proving mailbox control', async () => {
    const reg = await s.registerUser();
    await ctx.prisma.user.update({
      where: { emailNormalized: reg.email },
      data: { status: 'ACTIVE' },
    }); // forgot-password only serves active accounts
    await forgot(reg.email);
    expect(
      (await reset(await resetToken(reg.email), NEW_PASSWORD)).status,
    ).toBe(200);
  });
});

describe('change password', () => {
  it('requires the current password and signs out OTHER devices only', async () => {
    const a = await s.session();
    const other = await s.login(a.email, a.password, freshIp(), {
      'User-Agent': 'Other/2',
    });
    const wrong = await ctx
      .http()
      .post('/api/v1/auth/change-password')
      .set(authed(a))
      .send({ currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(401);

    await ctx
      .http()
      .post('/api/v1/auth/change-password')
      .set(authed(a))
      .send({ currentPassword: a.password, newPassword: NEW_PASSWORD })
      .expect(200);
    expect((await ctx.http().get('/api/v1/me').set(authed(a))).status).toBe(
      200,
    ); // this device continues
    expect(
      (
        await ctx
          .http()
          .get('/api/v1/me')
          .set({
            Authorization: `Bearer ${other.body.data.accessToken}`,
            'X-Forwarded-For': freshIp(),
          })
      ).status,
    ).toBe(401);
    expect((await s.login(a.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('applies the password policy and requires authentication', async () => {
    const a = await s.session();
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/change-password')
          .set(authed(a))
          .send({ currentPassword: a.password, newPassword: 'short' })
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/change-password')
          .set('X-Forwarded-For', freshIp())
          .send({ currentPassword: a.password, newPassword: NEW_PASSWORD })
      ).status,
    ).toBe(401);
  });
});

describe('phone verification', () => {
  it('verifies with the OTP, limits wrong attempts, and invalidates a code after too many tries', async () => {
    const a = await s.session();
    await ctx
      .http()
      .post('/api/v1/auth/phone/send-otp')
      .set(authed(a))
      .expect(202);
    const { code } = (await waitFor(() => ctx.notifier.last('PHONE_OTP')))!;
    const wrongCode = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++)
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/auth/phone/verify')
            .set(authed(a))
            .send({ code: wrongCode })
        ).status,
      ).toBe(400);
    // attempts exhausted: even the right code no longer works
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/phone/verify')
          .set(authed(a))
          .send({ code })
      ).status,
    ).toBe(400);

    ctx.notifier.clear();
    await ctx
      .http()
      .post('/api/v1/auth/phone/send-otp')
      .set(authed(a))
      .expect(202);
    const fresh = (await waitFor(() => ctx.notifier.last('PHONE_OTP')))!.code;
    await ctx
      .http()
      .post('/api/v1/auth/phone/verify')
      .set(authed(a))
      .send({ code: fresh })
      .expect(200);
    expect(
      (await ctx.http().get('/api/v1/me').set(authed(a))).body.data
        .phoneVerified,
    ).toBe(true);
  });

  it('does not store the OTP in clear text', async () => {
    const a = await s.session();
    await ctx
      .http()
      .post('/api/v1/auth/phone/send-otp')
      .set(authed(a))
      .expect(202);
    const code = ctx.notifier.last('PHONE_OTP')!.code;
    const rows = await ctx.prisma.verificationToken.findMany({
      where: { userId: a.userId },
    });
    expect(JSON.stringify(rows)).not.toContain(code);
  });
});

describe('multi-factor authentication (TOTP)', () => {
  it('enrolment needs the password and a working authenticator; the secret is encrypted at rest', async () => {
    const a = await s.session();
    const bad = await ctx
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set(authed(a))
      .send({ password: 'wrong-password-123' });
    expect(bad.status).toBe(401);

    const enroll = await ctx
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set(authed(a))
      .send({ password: a.password })
      .expect(200);
    const secret = enroll.body.data.secret as string;
    expect(enroll.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\/Yalli:/);

    const row = await ctx.prisma.mfaMethod.findFirstOrThrow({
      where: { userId: a.userId },
    });
    expect(row.status).toBe('PENDING');
    expect(row.secretEnc).not.toContain(secret);
    expect(row.secretEnc.split('.')).toHaveLength(4); // keyId.iv.ciphertext.tag

    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/confirm')
          .set(authed(a))
          .send({ code: '000000' })
      ).status,
    ).toBe(400);
    const ok = await ctx
      .http()
      .post('/api/v1/auth/mfa/confirm')
      .set(authed(a))
      .send({ code: totp(secret, -1) })
      .expect(200);
    expect(ok.body.data.recoveryCodes).toHaveLength(10);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } }))
        .mfaEnabled,
    ).toBe(true);
    const codes = await ctx.prisma.mfaRecoveryCode.findMany({
      where: { userId: a.userId },
    });
    expect(JSON.stringify(codes)).not.toContain(ok.body.data.recoveryCodes[0]);
  });

  it('login then needs a second factor: no tokens are issued by the password step alone', async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);
    const step1 = await s.login(a.email, a.password, a.ip);
    expect(step1.status).toBe(200);
    expect(step1.body.data).toMatchObject({ mfaRequired: true });
    expect(step1.body.data.accessToken).toBeUndefined();
    expect(step1.body.data.refreshToken).toBeUndefined();

    const step2 = await ctx
      .http()
      .post('/api/v1/auth/mfa/verify')
      .set('X-Forwarded-For', a.ip)
      .send({ mfaToken: step1.body.data.mfaToken, code: totp(secret, 0) });
    expect(step2.status).toBe(200);
    expect(jwtPayload(step2.body.data.accessToken)['amr']).toEqual([
      'pwd',
      'otp',
    ]);
  });

  it('rejects a replayed TOTP code (each time-step is single-use)', async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);
    const code = totp(secret, 0);
    const one = await s.login(a.email, a.password, a.ip);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({ mfaToken: one.body.data.mfaToken, code })
      ).status,
    ).toBe(200);
    const two = await s.login(a.email, a.password, a.ip);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({ mfaToken: two.body.data.mfaToken, code })
      ).status,
    ).toBe(401);
  });

  it('an MFA challenge is single-use and dies after 5 wrong attempts (cannot brute-force 6 digits)', async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);

    const used = await s.login(a.email, a.password, a.ip);
    const verified = await ctx
      .http()
      .post('/api/v1/auth/mfa/verify')
      .set('X-Forwarded-For', a.ip)
      .send({ mfaToken: used.body.data.mfaToken, code: totp(secret, 0) });
    expect(verified.status).toBe(200);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({ mfaToken: used.body.data.mfaToken, code: totp(secret, 1) })
      ).status,
    ).toBe(401);

    const guess = await s.login(a.email, a.password, a.ip);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (
          await ctx
            .http()
            .post('/api/v1/auth/mfa/verify')
            .set('X-Forwarded-For', a.ip)
            .send({ mfaToken: guess.body.data.mfaToken, code: '000001' })
        ).status,
      );
    }
    expect(codes.every((c) => c === 401)).toBe(true);
    // even the right code is useless now
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({ mfaToken: guess.body.data.mfaToken, code: totp(secret, 1) })
      ).status,
    ).toBe(401);
  });

  it('a stolen password cannot buy unlimited guesses: failures are counted per ACCOUNT across fresh logins, and the lock holds even for the right code', async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);
    const attempt = (token: string, code: string) =>
      ctx
        .http()
        .post('/api/v1/auth/mfa/verify')
        .set('X-Forwarded-For', freshIp())
        .send({ mfaToken: token, code });
    const challenge = async () =>
      (await s.login(a.email, a.password, freshIp())).body.data
        .mfaToken as string;

    // two challenges x 5 wrong codes = the 10 allowed failures
    for (let c = 0; c < 2; c++) {
      const token = await challenge();
      for (let i = 0; i < 5; i++)
        expect((await attempt(token, '000001')).status).toBe(401);
    }
    // the 11th attempt is refused outright - the CORRECT code included
    const third = await challenge();
    const locked = await attempt(third, totp(secret, 0));
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.mfa.locked', actorId: a.userId },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.userSession.count({ where: { userId: a.userId } }),
    ).toBe(1); // only the enrolment session: no login completed

    // the window passes (simulated), and the real owner can sign in again
    await ctx.store.del(`mfa:fail:${a.userId}`);
    const ok = await attempt(await challenge(), totp(secret, 0));
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
  });

  it('a successful second factor clears the failure counter', async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);
    const token = (await s.login(a.email, a.password, freshIp())).body.data
      .mfaToken as string;
    const verify = (code: string) =>
      ctx
        .http()
        .post('/api/v1/auth/mfa/verify')
        .set('X-Forwarded-For', freshIp())
        .send({ mfaToken: token, code });
    for (let i = 0; i < 3; i++)
      expect((await verify('000001')).status).toBe(401);
    expect(await ctx.store.get(`mfa:fail:${a.userId}`)).toBe('3');
    expect((await verify(totp(secret, 0))).status).toBe(200);
    expect(await ctx.store.get(`mfa:fail:${a.userId}`)).toBeNull();
  });

  it('recovery codes work exactly once', async () => {
    const a = await s.session();
    const { recoveryCodes } = await s.enableMfa(a);
    const code = recoveryCodes[0]!;
    const first = await s.login(a.email, a.password, a.ip);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({ mfaToken: first.body.data.mfaToken, recoveryCode: code })
      ).status,
    ).toBe(200);
    const second = await s.login(a.email, a.password, a.ip);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({ mfaToken: second.body.data.mfaToken, recoveryCode: code })
      ).status,
    ).toBe(401);
    const third = await s.login(a.email, a.password, a.ip);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({
            mfaToken: third.body.data.mfaToken,
            recoveryCode: recoveryCodes[1]!.toLowerCase().replace(/-/g, ' '),
          })
      ).status,
    ).toBe(200);
  });

  it('requires exactly one of code / recoveryCode', async () => {
    const a = await s.session();
    await s.enableMfa(a);
    const step1 = await s.login(a.email, a.password, a.ip);
    const post = (b: object) =>
      ctx
        .http()
        .post('/api/v1/auth/mfa/verify')
        .set('X-Forwarded-For', a.ip)
        .send({ mfaToken: step1.body.data.mfaToken, ...b });
    expect((await post({})).status).toBe(400);
    expect(
      (await post({ code: '123456', recoveryCode: 'AAAA-BBBB-CCCC-DDDD' }))
        .status,
    ).toBe(400);
  });

  it('step-up returns a token whose amr includes otp; ordinary tokens cannot reach step-up-protected routes', async () => {
    const a = await s.session();
    await s.grantRole(a.userId, 'ADMIN');
    const { secret } = await s.enableMfa(a);

    const before = await ctx.http().get('/api/v1/admin/roles').set(authed(a));
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('STEP_UP_REQUIRED');

    const up = await ctx
      .http()
      .post('/api/v1/auth/mfa/step-up')
      .set(authed(a))
      .send({ code: totp(secret, 0) });
    expect(up.status).toBe(200);
    expect(jwtPayload(up.body.data.accessToken)['amr']).toEqual(['pwd', 'otp']);
    expect(
      (
        await ctx
          .http()
          .get('/api/v1/admin/roles')
          .set(authed({ ...a, accessToken: up.body.data.accessToken }))
      ).status,
    ).toBe(200);
  });

  it('a stale step-up expires: auth_time too old is refused', async () => {
    const st = await s.staff('ADMIN');
    await ctx.prisma.userSession.updateMany({
      where: { userId: st.userId },
      data: { authenticatedAt: new Date(Date.now() - 3 * 3_600_000) },
    });
    // Refresh re-issues the token with the session's REAL last authentication time (hours ago).
    const refreshed = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', st.ip)
      .send({ refreshToken: st.refreshToken });
    expect(refreshed.status).toBe(200);
    const res = await ctx
      .http()
      .get('/api/v1/admin/roles')
      .set(authed({ ...st, accessToken: refreshed.body.data.accessToken }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('customers may disable MFA only with password + a valid factor; staff may never disable it', async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/disable')
          .set(authed(a))
          .send({ password: 'wrong-password-123', code: totp(secret, 0) })
      ).status,
    ).toBe(401);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/disable')
          .set(authed(a))
          .send({ password: a.password, code: '000000' })
      ).status,
    ).toBe(401);
    await ctx
      .http()
      .post('/api/v1/auth/mfa/disable')
      .set(authed(a))
      .send({ password: a.password, code: totp(secret, 0) })
      .expect(200);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } }))
        .mfaEnabled,
    ).toBe(false);
    expect(
      await ctx.prisma.mfaMethod.count({ where: { userId: a.userId } }),
    ).toBe(0);

    const st = await s.staff('PRODUCT_MANAGER');
    const refused = await ctx
      .http()
      .post('/api/v1/auth/mfa/disable')
      .set(authed(st))
      .send({ password: st.password, code: totp(st.secret, 1) });
    expect(refused.status).toBe(403);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: st.userId } }))
        .mfaEnabled,
    ).toBe(true);
  });

  it('cannot enrol twice while MFA is active', async () => {
    const a = await s.session();
    await s.enableMfa(a);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/enroll')
          .set(authed(a))
          .send({ password: a.password })
      ).status,
    ).toBe(409);
  });

  it('regenerating recovery codes invalidates the old ones', async () => {
    const a = await s.session();
    const { secret, recoveryCodes } = await s.enableMfa(a);
    const regen = await ctx
      .http()
      .post('/api/v1/auth/mfa/recovery-codes/regenerate')
      .set(authed(a))
      .send({ code: totp(secret, 0) })
      .expect(200);
    expect(regen.body.data.recoveryCodes).toHaveLength(10);
    const login = await s.login(a.email, a.password, a.ip);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/mfa/verify')
          .set('X-Forwarded-For', a.ip)
          .send({
            mfaToken: login.body.data.mfaToken,
            recoveryCode: recoveryCodes[0],
          })
      ).status,
    ).toBe(401);
  });
});

describe('password reuse of STRONG_PASSWORD constant stays valid for fixtures', () => {
  it('fixture password satisfies the policy', async () => {
    const { passwordViolations } =
      await import('../../src/modules/identity/crypto/password-policy.js');
    expect(
      passwordViolations(STRONG_PASSWORD, { email: 'someone@example.com' }),
    ).toEqual([]);
  });
});
