import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma's migration engine (not node-postgres) has its OWN TLS settings: it understands only sslmode
 * disable|prefer|require, silently turns any other mode (verify-full) into "prefer", ignores sslrootcert, and checks the
 * server certificate only with `sslaccept=strict` and `sslcert=<root CA file>` (first certificate of the file only).
 * Those ignored settings are refused everywhere (they look safe and are not); in the migrate image
 * (MIGRATE_REQUIRE_VERIFIED_TLS=1, root Dockerfile) a verified connection is required. Messages never contain the URL.
 */
export function migrationUrlProblem(
  url: string,
  requireVerified: boolean,
): string | null {
  if (!url) return null; // generate / validate without a database
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return 'DATABASE_MIGRATION_URL is not a URL';
  }
  const mode = params.get('sslmode');
  const fix =
    'use ?sslmode=require&sslaccept=strict&sslcert=/etc/ssl/certs/rds-root.pem';
  if (mode !== null && !['disable', 'prefer', 'require'].includes(mode))
    return `DATABASE_MIGRATION_URL: Prisma's migration engine does not understand sslmode=${mode.slice(0, 20)} (it would fall back to "prefer", which verifies nothing): ${fix}`;
  if (params.has('sslrootcert'))
    return `DATABASE_MIGRATION_URL: Prisma's migration engine ignores sslrootcert: ${fix}`;
  if (
    requireVerified &&
    (mode !== 'require' ||
      params.get('sslaccept') !== 'strict' ||
      !params.get('sslcert'))
  )
    return `DATABASE_MIGRATION_URL must verify the database certificate in the migrate image: ${fix}`;
  return null;
}

const url = process.env['DATABASE_MIGRATION_URL'] ?? '';
const problem = migrationUrlProblem(
  url,
  process.env['MIGRATE_REQUIRE_VERIFIED_TLS'] === '1',
);
if (problem) throw new Error(problem);

// The CLI (migrate/generate) uses the MIGRATOR credentials (DDL rights).
// The running application uses a different, DML-only role via DATABASE_URL (see src/config/env.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
