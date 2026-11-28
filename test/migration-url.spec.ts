import { describe, expect, it } from 'vitest';
import { migrationUrlProblem } from '../prisma.config.js';

const base = 'postgresql://yalli_migrator:pw@db.internal:5432/yalli';
const verified = `${base}?sslmode=require&sslaccept=strict&sslcert=/etc/ssl/certs/rds-root.pem`;

describe('migrator URL TLS (Prisma migration engine)', () => {
  it('accepts a verified connection, and a plain one outside the migrate image', () => {
    expect(migrationUrlProblem(verified, true)).toBeNull();
    expect(migrationUrlProblem(base, false)).toBeNull();
    expect(migrationUrlProblem('', true)).toBeNull();
  });

  it('refuses settings Prisma silently ignores (they look safe and verify nothing)', () => {
    expect(migrationUrlProblem(`${base}?sslmode=verify-full`, false)).toMatch(
      /does not understand sslmode=verify-full/,
    );
    expect(
      migrationUrlProblem(
        `${base}?sslmode=require&sslrootcert=/etc/ssl/certs/x.pem`,
        false,
      ),
    ).toMatch(/ignores sslrootcert/);
  });

  it('requires require + strict + a CA file in the migrate image', () => {
    for (const url of [
      base,
      `${base}?sslmode=require`,
      `${base}?sslmode=require&sslaccept=strict`,
      `${base}?sslmode=prefer&sslaccept=strict&sslcert=/x.pem`,
      `${base}?sslmode=require&sslaccept=accept_invalid_certs&sslcert=/x.pem`,
    ])
      expect(migrationUrlProblem(url, true)).toMatch(/must verify/);
  });

  it('never repeats the URL (it holds the migrator password)', () => {
    for (const url of [`${base}?sslmode=verify-full`, base, 'not a url pw'])
      expect(String(migrationUrlProblem(url, true))).not.toContain('pw');
  });
});
