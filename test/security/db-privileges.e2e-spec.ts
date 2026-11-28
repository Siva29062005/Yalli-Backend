import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DatabasePrivilegeCheck,
  FORBIDDEN_PRIVILEGES,
} from '../../src/infrastructure/database/privilege-check.js';
import { createTestApp, type TestContext } from '../support/test-app.js';

let ctx: TestContext;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe('database privileges of the app login (append-only tables)', () => {
  it('the app role holds none of the forbidden rights (the migrations revoked them)', async () => {
    expect(FORBIDDEN_PRIVILEGES.length).toBeGreaterThan(30);
    expect(await ctx.app.get(DatabasePrivilegeCheck).held()).toEqual([]);
  });

  it('production refuses to start when the login could rewrite history; elsewhere it warns', async () => {
    const make = (env: string) => {
      const check = new DatabasePrivilegeCheck(ctx.prisma, {
        get: () => env,
      } as unknown as ConfigService<never, true>);
      vi.spyOn(check, 'held').mockResolvedValue(['UPDATE on audit_logs']);
      return check;
    };
    await expect(make('production').onApplicationBootstrap()).rejects.toThrow(
      /UPDATE on audit_logs/,
    );
    await expect(
      make('development').onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});
