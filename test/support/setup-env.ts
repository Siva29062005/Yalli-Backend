import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, inject } from 'vitest';

/**
 * Runs before each test file's imports. Clones the migrated template into a PRIVATE database for this file and points
 * DATABASE_URL at it (the application reads it while its modules are evaluated). The copy is dropped afterwards.
 */
const name = `t_${randomBytes(6).toString('hex')}`;
const admin = () => new pg.Client({ connectionString: inject('adminUrl') });

async function createDatabase(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const client = admin();
    await client.connect();
    try {
      await client.query(
        `CREATE DATABASE "${name}" TEMPLATE "${inject('templateDb')}" OWNER yalli_migrator`,
      );
      return;
    } catch (err) {
      // Several files may clone at once; PostgreSQL briefly refuses while the template is being read.
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    } finally {
      await client.end();
    }
  }
}

await createDatabase();
process.env['DATABASE_URL'] =
  `postgresql://yalli_app:a@${inject('host')}:${inject('port')}/${name}`;

process.env['REPORTING_DATABASE_URL'] =
  `postgresql://yalli_reporting:r@${inject('host')}:${inject('port')}/${name}`;

afterAll(async () => {
  const client = admin();
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
});
