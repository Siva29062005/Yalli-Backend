import { Controller, Get, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { ROLE_DEFINITIONS } from '../../src/modules/access/permissions.js';
import { InMemoryEphemeralStore } from '../../src/infrastructure/cache/in-memory-ephemeral-store.js';
import { EphemeralStore } from '../../src/infrastructure/cache/ephemeral-store.js';
import { RedisService } from '../../src/infrastructure/cache/redis.service.js';
import {
  Scenario,
  STRONG_PASSWORD,
  authed,
  createTestApp,
  freshIp,
  totp,
  waitFor,
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

const as = (who: Pick<Session, 'accessToken' | 'ip'>) => authed(who);
const roleOf = (userId: string) =>
  ctx.prisma.userRole
    .findMany({ where: { userId }, include: { role: true } })
    .then((r) => r.map((x) => x.role.name).sort());

describe('deny by default', () => {
  it('the application REFUSES TO START if any route lacks an access policy', async () => {
    @Controller('oops')
    class ForgottenController {
      @Get()
      secret() {
        return 'oops';
      }
    }
    @Module({ controllers: [ForgottenController] })
    class ForgottenModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ForgottenModule],
    })
      .overrideProvider(RedisService)
      .useValue({
        client: {},
        ping: () => Promise.resolve(),
        onModuleDestroy: () => undefined,
      })
      .overrideProvider(EphemeralStore)
      .useValue(new InMemoryEphemeralStore())
      .compile();
    const app = moduleRef.createNestApplication();
    await expect(app.init()).rejects.toThrow(
      /without an access policy[\s\S]*ForgottenController\.secret/,
    );
    await app.close().catch(() => undefined);
  });

  it.each([
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/auth/sessions'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/logout-all'],
    ['POST', '/api/v1/auth/change-password'],
    ['POST', '/api/v1/auth/mfa/enroll'],
    ['POST', '/api/v1/auth/mfa/confirm'],
    ['POST', '/api/v1/auth/mfa/step-up'],
    ['POST', '/api/v1/auth/mfa/disable'],
    ['POST', '/api/v1/auth/phone/send-otp'],
    ['GET', '/api/v1/admin/roles'],
    ['GET', '/api/v1/admin/permissions'],
    ['POST', '/api/v1/admin/users/0190a7c0-0000-7000-8000-000000000000/roles'],
    [
      'PATCH',
      '/api/v1/admin/users/0190a7c0-0000-7000-8000-000000000000/status',
    ],
  ])('%s %s requires authentication', async (method, path) => {
    const req = ctx
      .http()
      [method.toLowerCase() as 'get'](path)
      .set('X-Forwarded-For', freshIp());
    expect((await req).status).toBe(401);
    expect(
      (
        await ctx
          .http()
          [method.toLowerCase() as 'get'](path)
          .set({ Authorization: 'Bearer abc', 'X-Forwarded-For': freshIp() })
      ).status,
    ).toBe(401);
    expect(
      (
        await ctx.http()[method.toLowerCase() as 'get'](path).set({
          Authorization: 'Basic dXNlcjpwdw==',
          'X-Forwarded-For': freshIp(),
        })
      ).status,
    ).toBe(401);
  });

  it('the public surface is exactly what we intend (health, JWKS, and the pre-login auth endpoints)', async () => {
    expect((await ctx.http().get('/health/live')).status).toBe(200);
    expect((await ctx.http().get('/.well-known/jwks.json')).status).toBe(200);
    // an undeclared path is a plain 404 with the safe envelope: no hint about what exists
    const unknown = await ctx
      .http()
      .get('/api/v1/admin')
      .set('X-Forwarded-For', freshIp());
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe('Resource not found');
  });
});

describe('vertical privilege escalation (BFLA): customers and low roles cannot reach admin functions', () => {
  it('a plain customer is forbidden (403) on every admin endpoint', async () => {
    const c = await s.session();
    const target = '0190a7c0-0000-7000-8000-000000000000';
    for (const [method, path, body] of [
      ['get', '/api/v1/admin/roles', undefined],
      ['get', '/api/v1/admin/permissions', undefined],
      ['get', '/api/v1/admin/users', undefined],
      ['post', `/api/v1/admin/users/${target}/roles`, { role: 'ADMIN' }],
      ['delete', `/api/v1/admin/users/${target}/roles/ADMIN`, undefined],
      [
        'patch',
        `/api/v1/admin/users/${target}/status`,
        { status: 'SUSPENDED' },
      ],
    ] as const) {
      const res = await ctx.http()[method](path).set(as(c)).send(body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('self-escalation: a customer cannot grant THEMSELVES a role, however they ask', async () => {
    const c = await s.session();
    const res = await ctx
      .http()
      .post(`/api/v1/admin/users/${c.userId}/roles`)
      .set(as(c))
      .send({ role: 'SUPER_ADMIN' });
    expect(res.status).toBe(403);
    expect(await roleOf(c.userId)).toEqual(['CUSTOMER']);
  });

  it('a staff role without users.manage (e.g. PRODUCT_MANAGER) cannot manage roles or accounts', async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const victim = await s.session();
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/users/${victim.userId}/roles`)
          .set(as(pm))
          .send({ role: 'CUSTOMER_SUPPORT' })
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/users/${victim.userId}/status`)
          .set(as(pm))
          .send({ status: 'SUSPENDED' })
      ).status,
    ).toBe(403);
    expect(
      (await ctx.http().get('/api/v1/admin/permissions').set(as(pm))).status,
    ).toBe(403);
    expect(
      (await ctx.http().get('/api/v1/admin/users').set(as(pm))).status,
    ).toBe(403);
  });

  it('GET /admin/roles marks only the roles the caller may give (ADMIN: never SUPER_ADMIN or ADMIN)', async () => {
    const admin = await s.staff('ADMIN');
    const roles = (
      await ctx.http().get('/api/v1/admin/roles').set(as(admin)).expect(200)
    ).body.data as { name: string; assignable: boolean }[];
    const flag = (n: string) => roles.find((r) => r.name === n)?.assignable;
    expect(flag('SUPER_ADMIN')).toBe(false);
    expect(flag('ADMIN')).toBe(false);
    expect(flag('PRODUCT_MANAGER')).toBe(true);
    // ADMIN does not hold refunds.create, so it cannot hand out roles that carry it (no permission laundering)
    expect(flag('CUSTOMER_SUPPORT')).toBe(false);
    expect(flag('FINANCE_MANAGER')).toBe(false);
    // the flag matches what the server then decides
    const victim = await s.session();
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/users/${victim.userId}/roles`)
          .set(as(admin))
          .send({ role: 'SUPER_ADMIN' })
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/users/${victim.userId}/roles`)
          .set(as(admin))
          .send({ role: 'CUSTOMER_SUPPORT' })
      ).status,
    ).toBe(403);
  });

  it("/me reports the caller's own effective permissions: a role's exact set for staff, none for a customer", async () => {
    const pm = await s.staff('PRODUCT_MANAGER');
    const fromApi = (await ctx.http().get('/api/v1/me').set(as(pm)).expect(200))
      .body.data.permissions as string[];
    expect(fromApi).toEqual(
      [...ROLE_DEFINITIONS.PRODUCT_MANAGER.permissions].sort(),
    );
    expect(fromApi).toContain('products.read');
    expect(fromApi).not.toContain('users.manage');
    const customer = await s.session();
    expect(
      (await ctx.http().get('/api/v1/me').set(as(customer)).expect(200)).body
        .data.permissions,
    ).toEqual([]);
    // revoking access takes effect immediately, as everywhere else (database-backed, not token-backed)
    const support = await s.staff('CUSTOMER_SUPPORT');
    expect(
      (await ctx.http().get('/api/v1/me').set(as(support)).expect(200)).body
        .data.permissions,
    ).not.toContain('analytics.read');
  });

  it('the staff user list is searchable and filterable, and never exposes credentials or contact numbers', async () => {
    const admin = await s.staff('ADMIN');
    const support = await s.staff('CUSTOMER_SUPPORT');
    const listed = await ctx
      .http()
      .get('/api/v1/admin/users')
      .query({ q: support.email, role: 'CUSTOMER_SUPPORT' })
      .set(as(admin))
      .expect(200);
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        id: support.userId,
        email: support.email,
        mfaEnabled: true,
        status: 'ACTIVE',
        roles: expect.arrayContaining(['CUSTOMER_SUPPORT']),
      }),
    ]);
    expect(listed.body.meta).toMatchObject({ page: 1, total: 1 });
    expect(JSON.stringify(listed.body)).not.toMatch(
      /passwordHash|password_hash|secret|phone/i,
    );
    // strict query: unknown parameters and unknown roles are refused
    await ctx
      .http()
      .get('/api/v1/admin/users')
      .query({ sort: 'email' })
      .set(as(admin))
      .expect(400);
    await ctx
      .http()
      .get('/api/v1/admin/users')
      .query({ role: 'GOD' })
      .set(as(admin))
      .expect(400);
    await ctx.http().get('/api/v1/admin/users').expect(401);
  });

  it('an ADMIN lacks roles.manage/permissions.manage: cannot list the permission catalogue', async () => {
    const admin = await s.staff('ADMIN');
    expect(
      (await ctx.http().get('/api/v1/admin/permissions').set(as(admin))).status,
    ).toBe(403);
    expect(
      (await ctx.http().get('/api/v1/admin/roles').set(as(admin))).status,
    ).toBe(200);
  });

  it('admin routes also demand MFA step-up: an ADMIN with only a password-authenticated token is refused', async () => {
    const a = await s.session();
    await s.grantRole(a.userId, 'ADMIN');
    const res = await ctx.http().get('/api/v1/admin/roles').set(as(a));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('denied attempts are audited', async () => {
    const c = await s.session();
    await ctx.http().get('/api/v1/admin/roles').set(as(c));
    const row = await ctx.prisma.auditLog.findFirst({
      where: { actorId: c.userId, action: 'access.denied' },
    });
    expect(row).toMatchObject({ outcome: 'DENIED' });
  });
});

describe('role management rules', () => {
  it('an ADMIN can grant a lower-ranked role they fully hold; the person is signed out and has it at the next (MFA) sign-in', async () => {
    const admin = await s.staff('ADMIN');
    const target = await s.session();
    const { secret } = await s.enableMfa(target); // a staff role is only given to someone who already has a second factor
    await ctx
      .http()
      .post(`/api/v1/admin/users/${target.userId}/roles`)
      .set(as(admin))
      .send({ role: 'ORDER_MANAGER' })
      .expect(200);
    // The session opened as a customer cannot carry the staff role (it may be "remembered" for weeks).
    const old = await ctx.http().get('/api/v1/me').set(as(target));
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('ACCESS_TOKEN_INVALID');
    // …and its refresh token is dead too (that "remembered" session was the risk).
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/refresh')
          .set('X-Forwarded-For', target.ip)
          .send({ refreshToken: target.refreshToken })
      ).status,
    ).toBe(401);
    const login = await s.login(target.email, target.password, target.ip);
    expect(login.body.data.mfaRequired).toBe(true);
    const verified = await ctx
      .http()
      .post('/api/v1/auth/mfa/verify')
      .set('X-Forwarded-For', target.ip)
      .send({ mfaToken: login.body.data.mfaToken, code: totp(secret, 1) });
    expect(verified.status).toBe(200);
    const me = await ctx
      .http()
      .get('/api/v1/me')
      .set(as({ accessToken: verified.body.data.accessToken, ip: target.ip }));
    expect(me.body.data.roles.sort()).toEqual(['CUSTOMER', 'ORDER_MANAGER']);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'access.role.assigned',
        actorId: admin.userId,
        resourceId: target.userId,
      },
    });
    expect(audit.metadata).toMatchObject({ role: 'ORDER_MANAGER' });
  });

  it('re-granting a role the person already holds changes nothing and signs nobody out', async () => {
    const admin = await s.staff('ADMIN');
    const staff = await s.staff('ORDER_MANAGER');
    await ctx
      .http()
      .post(`/api/v1/admin/users/${staff.userId}/roles`)
      .set(as(admin))
      .send({ role: 'ORDER_MANAGER' })
      .expect(200);
    expect((await ctx.http().get('/api/v1/me').set(as(staff))).status).toBe(
      200,
    );
  });

  it('a staff role is refused until the person has two-step verification: nobody can enrol the first authenticator on a privileged account', async () => {
    const admin = await s.staff('ADMIN');
    const target = await s.session(); // password known (say, leaked), no MFA yet
    const assign = () =>
      ctx
        .http()
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set(as(admin))
        .send({ role: 'ORDER_MANAGER' });
    const refused = await assign();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('MFA_REQUIRED_FOR_STAFF');
    expect(await roleOf(target.userId)).toEqual(['CUSTOMER']);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'access.role.change_denied', actorId: admin.userId },
      }),
    ).toBeGreaterThanOrEqual(1);
    // a PENDING (unconfirmed) enrolment does not count
    await ctx
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set(as(target))
      .send({ password: target.password });
    expect((await assign()).status).toBe(409);
    // once the person has confirmed an authenticator, the role can be given
    const t2 = await s.session();
    await s.enableMfa(t2);
    await ctx
      .http()
      .post(`/api/v1/admin/users/${t2.userId}/roles`)
      .set(as(admin))
      .send({ role: 'ORDER_MANAGER' })
      .expect(200);
  });

  it('an ADMIN cannot grant ADMIN or SUPER_ADMIN, nor a role carrying permissions they lack (FINANCE_MANAGER)', async () => {
    const admin = await s.staff('ADMIN');
    const target = await s.session();
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'FINANCE_MANAGER']) {
      expect(
        (
          await ctx
            .http()
            .post(`/api/v1/admin/users/${target.userId}/roles`)
            .set(as(admin))
            .send({ role })
        ).status,
        role,
      ).toBe(403);
    }
    expect(await roleOf(target.userId)).toEqual(['CUSTOMER']);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'access.role.change_denied', actorId: admin.userId },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('an ADMIN cannot modify a peer, a SUPER_ADMIN, or themselves', async () => {
    const admin = await s.staff('ADMIN');
    const peer = await s.session();
    await s.grantRole(peer.userId, 'ADMIN');
    const boss = await s.session();
    await s.grantRole(boss.userId, 'SUPER_ADMIN');

    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/users/${peer.userId}/roles`)
          .set(as(admin))
          .send({ role: 'CUSTOMER_SUPPORT' })
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/admin/users/${boss.userId}/roles/SUPER_ADMIN`)
          .set(as(admin))
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .delete(`/api/v1/admin/users/${admin.userId}/roles/ADMIN`)
          .set(as(admin))
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/users/${peer.userId}/status`)
          .set(as(admin))
          .send({ status: 'SUSPENDED' })
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .patch(`/api/v1/admin/users/${boss.userId}/status`)
          .set(as(admin))
          .send({ status: 'SUSPENDED' })
      ).status,
    ).toBe(403);
    expect(await roleOf(boss.userId)).toContain('SUPER_ADMIN');
  });

  it('a SUPER_ADMIN may grant any role to someone else but still not to themselves', async () => {
    const root = await s.staff('SUPER_ADMIN');
    const target = await s.session();
    await s.enableMfa(target);
    await ctx
      .http()
      .post(`/api/v1/admin/users/${target.userId}/roles`)
      .set(as(root))
      .send({ role: 'ADMIN' })
      .expect(200);
    await ctx
      .http()
      .post(`/api/v1/admin/users/${target.userId}/roles`)
      .set(as(root))
      .send({ role: 'FINANCE_MANAGER' })
      .expect(200);
    expect(await roleOf(target.userId)).toEqual([
      'ADMIN',
      'CUSTOMER',
      'FINANCE_MANAGER',
    ]);
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/admin/users/${root.userId}/roles`)
          .set(as(root))
          .send({ role: 'ADMIN' })
      ).status,
    ).toBe(403);
    expect(
      (await ctx.http().get('/api/v1/admin/permissions').set(as(root))).body
        .data.length,
    ).toBeGreaterThanOrEqual(24);
  });

  it("revoking a role ends the target's sessions and takes effect at once", async () => {
    const root = await s.staff('SUPER_ADMIN');
    const target = await s.session();
    await s.grantRole(target.userId, 'ORDER_MANAGER');
    await ctx
      .http()
      .delete(`/api/v1/admin/users/${target.userId}/roles/ORDER_MANAGER`)
      .set(as(root))
      .expect(200);
    expect((await ctx.http().get('/api/v1/me').set(as(target))).status).toBe(
      401,
    );
    expect(await roleOf(target.userId)).toEqual(['CUSTOMER']);
  });

  it('the platform can never lose its last SUPER_ADMIN, even under concurrent revocations', async () => {
    const a = await s.staff('SUPER_ADMIN');
    const b = await s.staff('SUPER_ADMIN');
    const results = await Promise.all([
      ctx
        .http()
        .delete(`/api/v1/admin/users/${b.userId}/roles/SUPER_ADMIN`)
        .set(as(a)),
      ctx
        .http()
        .delete(`/api/v1/admin/users/${a.userId}/roles/SUPER_ADMIN`)
        .set(as(b)),
    ]);
    // Each request ends cleanly: success, a refusal, a retryable conflict, or - for the admin who lost the race - 401,
    // because revoking a role also ends that person's sessions. Never a 500.
    for (const r of results) expect([200, 401, 403, 409]).toContain(r.status);
    // The invariant is GLOBAL (other tests share this database, so a and b alone may legitimately both go).
    // The deterministic last-holder / conflict branches are covered in admin-access.service.spec.ts.
    expect(
      await ctx.prisma.userRole.count({
        where: { role: { name: 'SUPER_ADMIN' } },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('validates the input shape: unknown role, bad ids, extra fields (mass assignment)', async () => {
    const root = await s.staff('SUPER_ADMIN');
    const target = await s.session();
    const url = `/api/v1/admin/users/${target.userId}/roles`;
    expect(
      (await ctx.http().post(url).set(as(root)).send({ role: 'GOD_MODE' }))
        .status,
    ).toBe(400);
    expect(
      (
        await ctx
          .http()
          .post(url)
          .set(as(root))
          .send({ role: 'ADMIN', grantedBy: 'someone-else' })
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/admin/users/not-a-uuid/roles')
          .set(as(root))
          .send({ role: 'ADMIN' })
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx
          .http()
          .post(
            '/api/v1/admin/users/0190a7c0-0000-7000-8000-000000000000/roles',
          )
          .set(as(root))
          .send({ role: 'ADMIN' })
      ).status,
    ).toBe(404);
  });
});

describe('account suspension', () => {
  it('suspending kills existing sessions immediately and blocks sign-in; restoring re-enables it', async () => {
    const admin = await s.staff('ADMIN');
    const target = await s.session();
    expect((await ctx.http().get('/api/v1/me').set(as(target))).status).toBe(
      200,
    );

    await ctx
      .http()
      .patch(`/api/v1/admin/users/${target.userId}/status`)
      .set(as(admin))
      .send({ status: 'SUSPENDED', reason: 'chargeback fraud' })
      .expect(200);
    expect((await ctx.http().get('/api/v1/me').set(as(target))).status).toBe(
      401,
    );
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/auth/refresh')
          .set('X-Forwarded-For', freshIp())
          .send({ refreshToken: target.refreshToken })
      ).status,
    ).toBe(401);
    const blocked = await s.login(target.email, target.password);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');

    await ctx
      .http()
      .patch(`/api/v1/admin/users/${target.userId}/status`)
      .set(as(admin))
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect((await s.login(target.email, target.password)).status).toBe(200);
    const audit = await ctx.prisma.auditLog.findMany({
      where: {
        action: 'access.user.status_changed',
        resourceId: target.userId,
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.metadata)).toEqual([
      expect.objectContaining({
        from: 'ACTIVE',
        to: 'SUSPENDED',
        reason: 'chargeback fraud',
      }),
      expect.objectContaining({ from: 'SUSPENDED', to: 'ACTIVE' }),
    ]);
  });

  it("a deleted account's still-valid token stops working", async () => {
    const a = await s.session();
    await ctx.prisma.user.update({
      where: { id: a.userId },
      data: { status: 'DELETED' },
    });
    await ctx.app
      .get(
        (await import('../../src/modules/access/authorization.service.js'))
          .AuthorizationService,
      )
      .invalidate(a.userId);
    expect((await ctx.http().get('/api/v1/me').set(as(a))).status).toBe(401);
  });
});

describe('data exposure and audit integrity', () => {
  it("no response in a full user journey ever contains a password hash, secret or another user's data", async () => {
    const a = await s.session();
    const { secret } = await s.enableMfa(a);
    const bodies: string[] = [];
    const record = (r: { text: string }) => bodies.push(r.text);
    record(await ctx.http().get('/api/v1/me').set(as(a)));
    record(await ctx.http().get('/api/v1/auth/sessions').set(as(a)));
    record(
      await ctx
        .http()
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: a.email, password: 'wrong-password-123' }),
    );
    record(await ctx.http().get('/api/v1/admin/roles').set(as(a)));
    const all = bodies.join('\n');
    expect(all).not.toMatch(
      /\$argon2|passwordHash|secretEnc|tokenHash|codeHash/,
    );
    expect(all).not.toContain(secret);
    expect(all).not.toContain(STRONG_PASSWORD);
  });

  it('audit rows never contain passwords, tokens, secrets, OTPs or recovery codes', async () => {
    const a = await s.session();
    await s.enableMfa(a);
    await s.login(a.email, 'wrong-password-12345', freshIp());
    const rows = JSON.stringify(
      await ctx.prisma.auditLog.findMany({ where: { actorId: a.userId } }),
    );
    expect(rows).not.toContain(STRONG_PASSWORD);
    expect(rows).not.toContain('wrong-password-12345');
    expect(rows).not.toContain(a.refreshToken);
    expect(rows).not.toContain(a.accessToken);
  });

  it('the audit trail is append-only even for the application database role', async () => {
    const a = await s.session();
    const row = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { actorId: a.userId },
    });
    await expect(
      ctx.prisma.auditLog.update({
        where: { id: row.id },
        data: { action: 'tampered' },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.auditLog.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    await expect(ctx.prisma.auditLog.deleteMany({})).rejects.toThrow();
    expect(
      await ctx.prisma.auditLog.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ action: row.action });
  });

  it('consent evidence is append-only too', async () => {
    const a = await s.session();
    await expect(
      ctx.prisma.consent.deleteMany({ where: { userId: a.userId } }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.consent.updateMany({
        where: { userId: a.userId },
        data: { version: 'v0' },
      }),
    ).rejects.toThrow();
  });

  it('the runtime role cannot change the schema or escalate in the database', async () => {
    await expect(
      ctx.prisma.$executeRawUnsafe('CREATE TABLE should_not_exist(x int)'),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.$executeRawUnsafe('CREATE ROLE evil SUPERUSER'),
    ).rejects.toThrow();
  });
});

describe('rate limiting', () => {
  it('flood control returns 429 with Retry-After and is audited once per window', async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await ctx
        .http()
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', ip)
        .send({});
      last = r.status;
    }
    expect(last).toBe(429);
    // The rejection is audited fire-and-forget (a throttled request must not wait for a DB write), so wait for the row.
    const limited = await waitFor(async () => {
      const n = await ctx.prisma.auditLog.count({
        where: { action: 'security.rate_limited', ip },
      });
      return n > 0 ? n : undefined;
    });
    expect(limited).toBe(1); // audited once per window, not once per rejected request
  });

  it('is enforced per authenticated user as well (a stolen token cannot hammer sensitive operations)', async () => {
    const a = await s.session();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push(
        (
          await ctx
            .http()
            .post('/api/v1/auth/mfa/enroll')
            .set({ ...as(a), 'X-Forwarded-For': freshIp() })
            .send({ password: 'wrong-password-123' })
        ).status,
      );
    expect(statuses.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
