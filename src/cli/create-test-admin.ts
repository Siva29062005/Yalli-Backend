import { NestFactory } from '@nestjs/core';
import { generateSecret, generateURI } from 'otplib';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { RoleName } from '../modules/access/permissions.js';
import { AuditAction } from '../modules/audit/audit-actions.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { passwordViolations } from '../modules/identity/crypto/password-policy.js';
import { PasswordService } from '../modules/identity/crypto/password.service.js';
import { SecretBox } from '../modules/identity/crypto/secret-box.service.js';

/**
 * DEVELOPMENT ONLY: creates an extra SUPER_ADMIN with a pre-enrolled TOTP secret so it can sign in
 * (password + authenticator code). Refuses to run in production and never modifies an existing user.
 */
async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production')
    throw new Error('create-test-admin is disabled in production');
  const email = process.env['TEST_ADMIN_EMAIL']?.trim();
  const password = process.env['TEST_ADMIN_PASSWORD'];
  if (!email || !password)
    throw new Error('TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD are required');
  const violations = passwordViolations(password, { email });
  if (violations.length > 0)
    throw new Error(`Password ${violations.join(', ')}`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const exists = await prisma.user.findFirst({
      where: { emailNormalized: email.toLowerCase() },
      select: { id: true },
    });
    if (exists) throw new Error(`User ${email} already exists; not modified`);

    const [superAdmin, customer] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { name: RoleName.SuperAdmin } }),
      prisma.role.findUniqueOrThrow({ where: { name: RoleName.Customer } }),
    ]);
    const passwordHash = await app.get(PasswordService).hash(password);
    const secret = generateSecret();

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          emailNormalized: email.toLowerCase(),
          passwordHash,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          mfaEnabled: true,
          customer: { create: { firstName: 'Test', lastName: 'Admin' } },
          roles: {
            create: [{ roleId: superAdmin.id }, { roleId: customer.id }],
          },
        },
        select: { id: true },
      });
      await tx.mfaMethod.create({
        data: {
          userId: u.id,
          secretEnc: app.get(SecretBox).encrypt(secret, `mfa:${u.id}`),
          status: 'ACTIVE',
          confirmedAt: new Date(),
        },
      });
      return u;
    });
    await app.get(AuditService).record({
      action: AuditAction.BootstrapAdminCreated,
      outcome: 'SUCCESS',
      actorType: 'SYSTEM',
      resourceType: 'user',
      resourceId: user.id,
    });

    console.log(`Created SUPER_ADMIN ${email}`);
    console.log(`MFA secret (add to authenticator): ${secret}`);
    console.log(
      `otpauth URI: ${generateURI({ issuer: 'Yalli (dev)', label: email, secret })}`,
    );
  } finally {
    await app.close();
  }
}

await main();
