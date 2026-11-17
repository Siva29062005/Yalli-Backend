import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the server (used only to clone per-file databases). */
    adminUrl: string;
    /** Name of the pre-migrated template database. */
    templateDb: string;
    host: string;
    port: number;
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/**
 * Starts a real PostgreSQL once per test run, creates the SAME two roles as production (DDL migrator vs DML-only app),
 * applies every migration as the migrator, and hands the app-role URL to the tests.
 * The security model depends on database constraints and grants, so tests must not run against a mock.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), 'yalli-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'pw',
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();

  const admin = new pg.Client({
    connectionString: `postgresql://postgres:pw@127.0.0.1:${port}/postgres`,
  });
  await admin.connect();
  await admin.query(`CREATE ROLE yalli_migrator LOGIN PASSWORD 'm'`);
  await admin.query(
    `CREATE ROLE yalli_app LOGIN PASSWORD 'a' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(
    `CREATE ROLE yalli_reporting LOGIN PASSWORD 'r' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE DATABASE yalli OWNER yalli_migrator`);
  await admin.end();

  const migrator = new pg.Client({
    connectionString: `postgresql://yalli_migrator:m@127.0.0.1:${port}/yalli`,
  });
  await migrator.connect();
  await migrator.query(
    `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO yalli_app;`,
  );
  await migrator.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE yalli_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yalli_app;`,
  );
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  for (const name of readdirSync(migrationsDir)
    .filter((n) => /^\d+_/.test(n))
    .sort()) {
    await migrator.query(
      readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'),
    );
  }
  await migrator.end();

  // `yalli` is now a read-only TEMPLATE: each test file clones it into its own private database (no shared state,
  // no cross-file interference, real migrations and real role grants in every copy).
  project.provide(
    'adminUrl',
    `postgresql://postgres:pw@127.0.0.1:${port}/postgres`,
  );
  project.provide('templateDb', 'yalli');
  project.provide('host', '127.0.0.1');
  project.provide('port', port);

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
