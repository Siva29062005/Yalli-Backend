import { Logger } from '@nestjs/common';
import { SeedService } from '../../src/modules/access/seed.service.js';
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
} from '../../src/modules/access/permissions.js';
import {
  Scenario,
  STRONG_PASSWORD,
  authed,
  createTestApp,
  freshIp,
  totp,
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

describe('role/permission seeding', () => {
  it('matches the definitions exactly (what the docs promise is what the database enforces)', async () => {
    for (const [name, def] of Object.entries(ROLE_DEFINITIONS)) {
      const role = await ctx.prisma.role.findUniqueOrThrow({
        where: { name },
        include: { permissions: { include: { permission: true } } },
      });
      expect(role.rank).toBe(def.rank);
      expect(role.permissions.map((p) => p.permission.name).sort()).toEqual(
        [...def.permissions].sort(),
      );
    }
    expect(await ctx.prisma.permission.count()).toBe(ALL_PERMISSIONS.length);
  });

  it('is idempotent and CORRECTS drift (a permission quietly added to a role is removed on the next sync)', async () => {
    const seed = ctx.app.get(SeedService);
    // A role no other test relies on, so this drift cannot disturb test files running in parallel.
    const victim = await ctx.prisma.role.findUniqueOrThrow({
      where: { name: 'INVENTORY_MANAGER' },
    });
    const rogue = await ctx.prisma.permission.findUniqueOrThrow({
      where: { name: 'refunds.approve' },
    });
    await ctx.prisma.rolePermission.create({
      data: { roleId: victim.id, permissionId: rogue.id },
    });

    // Two concurrent syncs must also be safe (advisory lock) and both converge on the definition.
    await Promise.all([
      seed.syncRolesAndPermissions(),
      seed.syncRolesAndPermissions(),
    ]);
    expect(
      await ctx.prisma.rolePermission.count({
        where: { roleId: victim.id, permissionId: rogue.id },
      }),
    ).toBe(0);
  });
});

describe('bootstrap super admin', () => {
  it('creates the first SUPER_ADMIN only when none exists, with no way to sign in without MFA for admin actions', async () => {
    const seed = ctx.app.get(SeedService);
    const email = uniqueEmail('root');
    const hash = await ctx.passwords.hash(STRONG_PASSWORD);

    // Other test files share this database and may already have created super admins.
    const existing = await ctx.prisma.userRole.count({
      where: { role: { name: 'SUPER_ADMIN' } },
    });
    const outcome = await seed.bootstrapSuperAdmin(email, hash);
    if (existing > 0) {
      expect(outcome).toBe('already-exists');
      expect(
        await ctx.prisma.user.count({ where: { emailNormalized: email } }),
      ).toBe(0);
      return;
    }
    expect(outcome).toBe('created');
    expect(await seed.bootstrapSuperAdmin(uniqueEmail('root2'), hash)).toBe(
      'already-exists',
    );

    const login = await s.login(email, STRONG_PASSWORD, freshIp());
    expect(login.status).toBe(200);
    const token = {
      accessToken: login.body.data.accessToken as string,
      ip: freshIp(),
    };
    const denied = await ctx
      .http()
      .get('/api/v1/admin/roles')
      .set(authed(token));
    expect(denied.body.error.code).toBe('STEP_UP_REQUIRED');
    expect(totp).toBeDefined();
  });

  it('refuses to create a second one on re-run (the CLI is safe to run on every deploy)', async () => {
    const seed = ctx.app.get(SeedService);
    const admin = await s.staff('SUPER_ADMIN');
    expect(admin.userId).toBeTruthy();
    expect(
      await seed.bootstrapSuperAdmin(
        uniqueEmail('late'),
        await ctx.passwords.hash(STRONG_PASSWORD),
      ),
    ).toBe('already-exists');
  });
});
