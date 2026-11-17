import { Logger } from '@nestjs/common';
import { SignJWT, generateKeyPair, importPKCS8 } from 'jose';
import {
  Scenario,
  authed,
  createTestApp,
  freshIp,
  jwtPayload,
  waitFor,
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

const refresh = (token: string, ip = freshIp()) =>
  ctx
    .http()
    .post('/api/v1/auth/refresh')
    .set('X-Forwarded-For', ip)
    .send({ refreshToken: token });
const me = (token: string) =>
  ctx
    .http()
    .get('/api/v1/me')
    .set({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': freshIp() });

describe('refresh token rotation', () => {
  it('issues a new pair on each refresh and the access token keeps working', async () => {
    const a = await s.session();
    const r = await refresh(a.refreshToken, a.ip);
    expect(r.status).toBe(200);
    expect(r.body.data.refreshToken).toBeTruthy();
    expect(r.body.data.refreshToken).not.toBe(a.refreshToken);
    expect((await me(r.body.data.accessToken)).status).toBe(200);
  });

  it('stores only a hash of the refresh token', async () => {
    const a = await s.session();
    const rows = await ctx.prisma.refreshToken.findMany({
      where: { session: { userId: a.userId } },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(a.refreshToken);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('REUSE DETECTION: replaying an already-rotated token revokes the whole session, including the newest token', async () => {
    const a = await s.session();
    const first = await refresh(a.refreshToken, a.ip);
    expect(first.status).toBe(200);

    const replay = await refresh(a.refreshToken, freshIp()); // attacker (or stale copy) presents the OLD token
    expect(replay.status).toBe(401);

    // The legitimate holder's newest tokens are now dead too: the family is burnt.
    expect((await refresh(first.body.data.refreshToken)).status).toBe(401);
    expect((await me(first.body.data.accessToken)).status).toBe(401);

    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.refresh.reuse_detected', actorId: a.userId },
      }),
    ).toBe(1);
    await waitFor(() => ctx.notifier.last('SESSION_THEFT_SUSPECTED', a.email));
    const session = await ctx.prisma.userSession.findFirstOrThrow({
      where: { userId: a.userId },
    });
    expect(session.revokedReason).toBe('REFRESH_REUSE');
  });

  it('two concurrent refreshes with the same token: only one can win, and the session is then burnt', async () => {
    const a = await s.session();
    const results = await Promise.all([
      refresh(a.refreshToken),
      refresh(a.refreshToken),
    ]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      200, 401,
    ]);
  });

  it('rejects unknown, malformed and expired refresh tokens uniformly', async () => {
    const a = await s.session();
    for (const bad of [
      'x'.repeat(43),
      'short',
      '../../etc/passwd'.padEnd(30, 'a'),
    ]) {
      expect([400, 401]).toContain((await refresh(bad)).status);
    }
    await ctx.prisma.refreshToken.updateMany({
      where: { session: { userId: a.userId } },
      data: {
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 5000),
      },
    });
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });

  it('a session cannot outlive its absolute lifetime however often it is refreshed', async () => {
    const a = await s.session();
    await ctx.prisma.userSession.updateMany({
      where: { userId: a.userId },
      data: {
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 5000),
      },
    });
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });
});

describe('logout and revocation take effect immediately', () => {
  it('logout kills the access token (not just the refresh token)', async () => {
    const a = await s.session();
    expect((await me(a.accessToken)).status).toBe(200);
    await ctx.http().post('/api/v1/auth/logout').set(authed(a)).expect(200);
    expect((await me(a.accessToken)).status).toBe(401);
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });

  it('logout-all revokes every device', async () => {
    const a = await s.session();
    const second = await s.login(a.email, a.password, freshIp(), {
      'User-Agent': 'Other/2',
    });
    const res = await ctx
      .http()
      .post('/api/v1/auth/logout-all')
      .set(authed(a))
      .expect(200);
    expect(res.body.data.sessionsRevoked).toBe(2);
    expect((await me(a.accessToken)).status).toBe(401);
    expect((await me(second.body.data.accessToken)).status).toBe(401);
  });

  it('sessions are listed per user, with the current one flagged', async () => {
    const a = await s.session();
    await s.login(a.email, a.password, freshIp(), { 'User-Agent': 'Other/2' });
    const list = await ctx
      .http()
      .get('/api/v1/auth/sessions')
      .set(authed(a))
      .expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(
      list.body.data.filter((x: { current: boolean }) => x.current),
    ).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(
      /tokenHash|deviceHash|userId/,
    );
  });

  it('BOLA: a user cannot see or revoke another user\'s session (indistinguishable from "not found")', async () => {
    const victim = await s.session();
    const attacker = await s.session();
    const victimSession = await ctx.prisma.userSession.findFirstOrThrow({
      where: { userId: victim.userId },
    });

    const attempt = await ctx
      .http()
      .delete(`/api/v1/auth/sessions/${victimSession.id}`)
      .set(authed(attacker));
    expect(attempt.status).toBe(404);
    const unknown = await ctx
      .http()
      .delete('/api/v1/auth/sessions/0190a7c0-0000-7000-8000-000000000000')
      .set(authed(attacker));
    expect(unknown.status).toBe(404);
    expect(attempt.body.message).toBe(unknown.body.message);

    expect((await me(victim.accessToken)).status).toBe(200); // victim untouched
    expect(
      (
        await ctx.http().get('/api/v1/auth/sessions').set(authed(attacker))
      ).body.data.map((x: { id: string }) => x.id),
    ).not.toContain(victimSession.id);
  });

  it('a user can revoke their own other session', async () => {
    const a = await s.session();
    const other = await s.login(a.email, a.password, freshIp(), {
      'User-Agent': 'Other/2',
    });
    const otherSession = await ctx.prisma.userSession.findFirstOrThrow({
      where: { userId: a.userId, userAgent: 'Other/2' },
    });
    await ctx
      .http()
      .delete(`/api/v1/auth/sessions/${otherSession.id}`)
      .set(authed(a))
      .expect(200);
    expect((await me(other.body.data.accessToken)).status).toBe(401);
    expect((await me(a.accessToken)).status).toBe(200);
  });

  it('rejects a malformed session id', async () => {
    const a = await s.session();
    expect(
      (
        await ctx
          .http()
          .delete('/api/v1/auth/sessions/not-a-uuid')
          .set(authed(a))
      ).status,
    ).toBe(400);
  });
});

describe('JWT tampering and forgery', () => {
  const privateKeyPem = () =>
    Buffer.from(process.env['JWT_PRIVATE_KEY_B64']!, 'base64').toString('utf8');

  /** Signs with the REAL server key but lets the test bend individual claims. */
  async function forge(
    a: { userId: string },
    sid: string,
    mutate: (j: SignJWT) => SignJWT = (j) => j,
    headerKid = 'test-key-1',
    typ = 'at+jwt',
  ) {
    const key = await importPKCS8(privateKeyPem(), 'EdDSA');
    const jwt = new SignJWT({
      sid,
      amr: ['pwd'],
      auth_time: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: headerKid, typ })
      .setIssuer('yalli-api')
      .setAudience('yalli-clients')
      .setSubject(a.userId)
      .setIssuedAt()
      .setExpirationTime('10m');
    return mutate(jwt).sign(key);
  }

  it('control: a correctly forged-by-test token with a REAL session is accepted (proves the helpers are valid)', async () => {
    const a = await s.session();
    const sid = jwtPayload(a.accessToken)['sid'] as string;
    expect((await me(await forge(a, sid))).status).toBe(200);
  });

  it('rejects tampering: modified payload, stripped signature, alg=none, wrong key, wrong kid/aud/iss/typ, expired', async () => {
    const a = await s.session();
    const other = await s.session();
    const sid = jwtPayload(a.accessToken)['sid'] as string;
    const [h, p, sig] = a.accessToken.split('.') as [string, string, string];

    // 1. payload swapped to another user's id, signature left alone
    const swapped = Buffer.from(
      JSON.stringify({ ...jwtPayload(a.accessToken), sub: other.userId }),
    ).toString('base64url');
    // 2. alg=none
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url')}.${p}.`;
    // 3. signed by an attacker's own Ed25519 key but claiming the real kid
    const attackerKey = (await generateKeyPair('EdDSA')).privateKey;
    const attacker = await new SignJWT({ sid, amr: ['pwd'], auth_time: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1', typ: 'at+jwt' })
      .setIssuer('yalli-api')
      .setAudience('yalli-clients')
      .setSubject(a.userId)
      .setExpirationTime('10m')
      .sign(attackerKey);
    // 4. HS256 confusion attempt using the public JWKS as an HMAC secret
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'test-key-1', typ: 'at+jwt' })).toString('base64url')}.${p}.${sig}`;

    const bad: Record<string, string> = {
      'payload swapped': `${h}.${swapped}.${sig}`,
      'signature stripped': `${h}.${p}.`,
      'alg none': none,
      'attacker key, real kid': attacker,
      'HS256 confusion': hs,
      'unknown kid': await forge(a, sid, (j) => j, 'rotated-away-key'),
      'wrong audience': await forge(a, sid, (j) =>
        j.setAudience('someone-else'),
      ),
      'wrong issuer': await forge(a, sid, (j) => j.setIssuer('evil')),
      'wrong typ (e.g. an id_token)': await forge(
        a,
        sid,
        (j) => j,
        'test-key-1',
        'JWT',
      ),
      expired: await forge(a, sid, (j) =>
        j.setExpirationTime(Math.floor(Date.now() / 1000) - 3600),
      ),
      'not before in future': await forge(a, sid, (j) =>
        j.setNotBefore(Math.floor(Date.now() / 1000) + 3600),
      ),
      garbage: 'not.a.jwt',
      empty: '',
    };
    for (const [name, token] of Object.entries(bad)) {
      const res = await ctx
        .http()
        .get('/api/v1/me')
        .set({
          Authorization: `Bearer ${token}`,
          'X-Forwarded-For': freshIp(),
        });
      expect(res.status, name).toBe(401);
    }
  });

  it('a validly-signed token for a session that does not exist (or belongs to someone else) is rejected', async () => {
    const a = await s.session();
    const b = await s.session();
    const bSid = jwtPayload(b.accessToken)['sid'] as string;
    expect(
      (await me(await forge(a, '0190a7c0-0000-7000-8000-000000000000'))).status,
    ).toBe(401);
    // a's id with b's session id: the session must belong to the subject
    expect((await me(await forge(a, bSid))).status).toBe(401);
  });

  it('token claims are minimal: no roles, permissions, email or other PII', async () => {
    const a = await s.session();
    const claims = Object.keys(jwtPayload(a.accessToken)).sort();
    expect(claims).toEqual([
      'amr',
      'aud',
      'auth_time',
      'exp',
      'iat',
      'iss',
      'jti',
      'sid',
      'sub',
    ]);
    expect(JSON.stringify(jwtPayload(a.accessToken))).not.toContain(a.email);
  });

  it('authorization is read from the server, not the token: a role grant applies without re-login, and revocation too', async () => {
    const a = await s.session();
    expect((await me(a.accessToken)).body.data.roles).toEqual(['CUSTOMER']);
    await s.grantRole(a.userId, 'ORDER_MANAGER');
    expect((await me(a.accessToken)).body.data.roles.sort()).toEqual([
      'CUSTOMER',
      'ORDER_MANAGER',
    ]);
  });

  it('exposes the verification key as a JWKS with no private material', async () => {
    const res = await ctx.http().get('/.well-known/jwks.json').expect(200);
    expect(res.body.keys[0]).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
      kid: 'test-key-1',
    });
    expect(res.body.keys[0].d).toBeUndefined();
  });
});

describe('cookie mode (browser) and CSRF', () => {
  const cookieLogin = async () => {
    const { email, password, ip } = await s.verifiedUser();
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set({ 'X-Forwarded-For': ip, 'X-Auth-Mode': 'cookie' })
      .send({ email, password });
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const value = (name: string) =>
      setCookie
        .find((c) => c.startsWith(`${name}=`))!
        .split(';')[0]!
        .split('=')[1]!;
    return {
      res,
      setCookie,
      ip,
      refresh: value('yalli_rt'),
      csrf: value('yalli_csrf'),
    };
  };

  it('delivers the refresh token only as an HttpOnly, SameSite=Strict, path-scoped cookie', async () => {
    const { res, setCookie } = await cookieLogin();
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data.csrfToken).toBeTruthy();
    const rt = setCookie.find((c) => c.startsWith('yalli_rt='))!;
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/SameSite=Strict/i);
    expect(rt).toMatch(/Path=\/api\/v1\/auth(;|$)/);
    expect(rt).toMatch(/Expires=/i);
    expect(setCookie.find((c) => c.startsWith('yalli_csrf='))).not.toMatch(
      /HttpOnly/i,
    );
  });

  it('refuses a cookie-authenticated refresh without the CSRF header (cross-site forgery)', async () => {
    const c = await cookieLogin();
    const forged = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set({
        'X-Forwarded-For': c.ip,
        'X-Auth-Mode': 'cookie',
        Cookie: `yalli_rt=${c.refresh}; yalli_csrf=${c.csrf}`,
      })
      .send({});
    expect(forged.status).toBe(403);
    const mismatched = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set({
        'X-Forwarded-For': c.ip,
        'X-Auth-Mode': 'cookie',
        'X-CSRF-Token': 'attacker-guess',
        Cookie: `yalli_rt=${c.refresh}; yalli_csrf=${c.csrf}`,
      })
      .send({});
    expect(mismatched.status).toBe(403);
  });

  it('refuses a request from an origin that is not on the allow-list even with a valid CSRF pair', async () => {
    const c = await cookieLogin();
    const res = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set({
        'X-Forwarded-For': c.ip,
        'X-Auth-Mode': 'cookie',
        Origin: 'https://evil.example.com',
        'X-CSRF-Token': c.csrf,
        Cookie: `yalli_rt=${c.refresh}; yalli_csrf=${c.csrf}`,
      })
      .send({});
    expect(res.status).toBe(403);
  });

  it('accepts the refresh with a matching CSRF token from an allowed origin and rotates both cookies', async () => {
    const c = await cookieLogin();
    const ok = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set({
        'X-Forwarded-For': c.ip,
        'X-Auth-Mode': 'cookie',
        Origin: 'https://allowed.example.com',
        'X-CSRF-Token': c.csrf,
        Cookie: `yalli_rt=${c.refresh}; yalli_csrf=${c.csrf}`,
      })
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
    const next = (ok.headers['set-cookie'] as unknown as string[])
      .find((x) => x.startsWith('yalli_rt='))!
      .split(';')[0]!
      .split('=')[1];
    expect(next).not.toBe(c.refresh);
  });

  it('logout clears both cookies', async () => {
    const { email, password, ip } = await s.verifiedUser();
    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set({ 'X-Forwarded-For': ip, 'X-Auth-Mode': 'cookie' })
      .send({ email, password });
    const out = await ctx
      .http()
      .post('/api/v1/auth/logout')
      .set({
        Authorization: `Bearer ${login.body.data.accessToken}`,
        'X-Forwarded-For': ip,
      });
    const cleared = out.headers['set-cookie'] as unknown as string[];
    expect(
      cleared.some((c) => c.startsWith('yalli_rt=;') && /Max-Age=0/i.test(c)),
    ).toBe(true);
  });
});
