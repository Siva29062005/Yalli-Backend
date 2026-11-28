import { Logger } from '@nestjs/common';
import pg from 'pg';
import { inject } from 'vitest';
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

  it('catches a table grant and a COLUMN grant given back to the app role (a later GRANT on RDS)', async () => {
    const [row] = await ctx.prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database()::text AS db`;
    const db = row!.db;
    const su = new pg.Client({
      connectionString: `postgresql://postgres:pw@${inject('host')}:${inject('port')}/${db}`,
    });
    await su.connect();
    const check = ctx.app.get(DatabasePrivilegeCheck);
    try {
      await su.query('GRANT DELETE ON orders TO yalli_app');
      expect(await check.held()).toEqual(['DELETE on orders']);
      await su.query('REVOKE DELETE ON orders FROM yalli_app');
      await su.query('GRANT UPDATE (metadata) ON audit_logs TO yalli_app');
      expect(await check.held()).toEqual(['UPDATE on audit_logs']);
    } finally {
      await su.query('REVOKE DELETE ON orders FROM yalli_app');
      await su.query('REVOKE UPDATE (metadata) ON audit_logs FROM yalli_app');
      await su.end();
    }
    expect(await check.held()).toEqual([]);
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
