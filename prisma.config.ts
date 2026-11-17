import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// The CLI (migrate/generate) uses the MIGRATOR credentials (DDL rights).
// The running application uses a different, DML-only role via DATABASE_URL (see src/config/env.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env['DATABASE_MIGRATION_URL'] ?? '',
  },
});
