import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { SeedService } from '../modules/access/seed.service.js';
import { passwordViolations } from '../modules/identity/crypto/password-policy.js';
import { PasswordService } from '../modules/identity/crypto/password.service.js';
import { emailOnlySchema } from '../modules/identity/dto/auth.schemas.js';

/**
 * One-off bootstrap, safe to re-run:
 *   1. syncs permissions + roles to the definitions in permissions.ts
 *   2. if BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD are set AND no SUPER_ADMIN exists, creates the first one.
 * The credentials come from the environment (a secret manager in production) and are never logged.
 * The new admin must enrol MFA on first sign-in before any admin endpoint will accept them (step-up is mandatory).
 */
async function main(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const seed = app.get(SeedService);
    await seed.syncRolesAndPermissions();
    await seed.ensureDefaultWarehouse();

    const email = process.env['BOOTSTRAP_ADMIN_EMAIL'];
    const password = process.env['BOOTSTRAP_ADMIN_PASSWORD'];
    if (!email && !password) {
      logger.log(
        'No BOOTSTRAP_ADMIN_* variables set: roles/permissions synced, no admin created',
      );
      return;
    }
    const parsed = emailOnlySchema.safeParse({ email });
    if (!parsed.success || !password)
      throw new Error(
        'BOOTSTRAP_ADMIN_EMAIL must be a valid email and BOOTSTRAP_ADMIN_PASSWORD must be set',
      );
    const violations = passwordViolations(password, {
      email: parsed.data.email,
    });
    if (violations.length > 0)
      throw new Error(`BOOTSTRAP_ADMIN_PASSWORD ${violations.join(', ')}`);

    const hash = await app.get(PasswordService).hash(password);
    const outcome = await seed.bootstrapSuperAdmin(parsed.data.email, hash);
    logger.log(
      outcome === 'created'
        ? 'Created the first SUPER_ADMIN. Sign in and enrol MFA, then rotate the bootstrap password.'
        : 'A SUPER_ADMIN already exists: nothing to do',
    );
  } finally {
    await app.close();
  }
}

await main();
