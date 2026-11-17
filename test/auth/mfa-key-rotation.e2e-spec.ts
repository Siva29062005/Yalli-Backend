import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../src/config/env.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { SecretBox } from '../../src/modules/identity/crypto/secret-box.service.js';
import { MfaKeyRotationService } from '../../src/modules/identity/services/mfa-key-rotation.service.js';
import {
  Scenario,
  createTestApp,
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

const OLD_KEY = process.env['MFA_ENCRYPTION_KEY_B64']!;
const OLD_ID = process.env['MFA_ENCRYPTION_KEY_ID'] ?? 'k1';
const box = (id: string, key: string, retired: Record<string, string> = {}) =>
  new SecretBox({
    get: (k: string) =>
      ({
        MFA_ENCRYPTION_KEY_B64: key,
        MFA_ENCRYPTION_KEY_ID: id,
        MFA_RETIRED_KEYS_JSON: JSON.stringify(retired),
      })[k],
  } as unknown as ConfigService<Env, true>);

describe('MFA key rotation', () => {
  it('re-encrypts every secret under the new key, keeps them readable, is repeatable, and never changes the secret itself', async () => {
    const users = [];
    for (let i = 0; i < 3; i++) {
      const u = await s.session();
      const { secret } = await s.enableMfa(u);
      users.push({ u, secret });
    }
    const before = await ctx.prisma.mfaMethod.findMany({
      where: { userId: { in: users.map((x) => x.u.userId) } },
    });
    expect(before.every((m) => m.secretEnc.startsWith(`${OLD_ID}.`))).toBe(
      true,
    );

    const newKey = randomBytes(32).toString('base64');
    const rotated = box('k9', newKey, { [OLD_ID]: OLD_KEY });
    const service = new MfaKeyRotationService(
      ctx.prisma,
      rotated,
      ctx.app.get(AuditService),
    );

    // dry run: reports, changes nothing
    const dry = await service.run(false);
    expect(dry).toMatchObject({ mode: 'DRY_RUN', failed: [] });
    expect(dry.rotated).toBeGreaterThanOrEqual(3);
    const stillOld = await ctx.prisma.mfaMethod.findMany({
      where: { id: { in: before.map((m) => m.id) } },
    });
    expect(stillOld.map((m) => m.secretEnc).sort()).toEqual(
      before.map((m) => m.secretEnc).sort(),
    );

    const applied = await service.run(true);
    expect(applied).toMatchObject({
      mode: 'APPLIED',
      skippedConcurrent: 0,
      failed: [],
    });
    const after = await ctx.prisma.mfaMethod.findMany({
      where: { id: { in: before.map((m) => m.id) } },
    });
    for (const m of after) {
      expect(m.secretEnc.startsWith('k9.')).toBe(true);
      const owner = users.find((x) => x.u.userId === m.userId)!;
      // same TOTP secret, now sealed under the new key (and still bound to its owner)
      expect(rotated.decrypt(m.secretEnc, `mfa:${m.userId}`)).toBe(
        owner.secret,
      );
      expect(() => rotated.decrypt(m.secretEnc, 'mfa:someone-else')).toThrow();
    }

    const again = await service.run(true);
    expect(again).toMatchObject({ rotated: 0, failed: [] });
    expect(again.alreadyCurrent).toBe(again.scanned);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'auth.mfa.secrets_rotated', actorType: 'SYSTEM' },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('reports (never leaks) rows it cannot decrypt, and still rotates the rest', async () => {
    const u = await s.session();
    await s.enableMfa(u);
    const broken = await ctx.prisma.mfaMethod.create({
      data: {
        userId: u.userId,
        secretEnc: 'zz.AAAA.BBBB.CCCC',
        status: 'PENDING',
      },
    });
    const service = new MfaKeyRotationService(
      ctx.prisma,
      box('k10', randomBytes(32).toString('base64'), {
        [OLD_ID]: OLD_KEY,
        k9: randomBytes(32).toString('base64'),
      }),
      ctx.app.get(AuditService),
    );
    const report = await service.run(true);
    expect(report.failed).toContain(broken.id);
    expect(JSON.stringify(report)).not.toContain('AAAA');
    expect(
      (
        await ctx.prisma.mfaMethod.findUniqueOrThrow({
          where: { id: broken.id },
        })
      ).secretEnc,
    ).toBe('zz.AAAA.BBBB.CCCC');
  });
});
