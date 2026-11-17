import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { MfaKeyRotationService } from '../modules/identity/services/mfa-key-rotation.service.js';

const USAGE = `Usage: node dist/cli/rotate-mfa-key.js [--apply]

  (default)  report how many stored MFA secrets are not yet encrypted under the current key; changes nothing
  --apply    re-encrypt them (safe to run on a live site and to re-run)
`;

async function main(): Promise<number> {
  if (process.argv.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const report = await app
      .get(MfaKeyRotationService)
      .run(process.argv.includes('--apply'));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.failed.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

process.exitCode = await main();
