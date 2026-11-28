import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS, serializeError } from './log-safety.js';

function capture(obj: Record<string, unknown>): string {
  let out = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  pino(
    {
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { err: serializeError },
    },
    stream,
  ).error(obj, 'test');
  return out;
}

describe('log safety', () => {
  it('keeps error codes and hides secrets', () => {
    const err = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    const line = capture({
      err,
      body: { password: 'hunter2', recoveryCode: 'abcd-efgh', mfaToken: 't0k' },
    });
    expect(line).toContain('"code":"P2002"');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('abcd-efgh');
    expect(line).not.toContain('t0k');
  });

  it('never prints the arguments of a Prisma validation error', () => {
    const err = new Error(
      'Invalid `prisma.user.create()` invocation: { email: "asha@example.test", passwordHash: "$argon2id$v=19..." }',
    );
    err.name = 'PrismaClientValidationError';
    const line = capture({ err });
    expect(line).toContain('PrismaClientValidationError');
    expect(line).not.toContain('asha@example.test');
    expect(line).not.toContain('argon2id');
  });
});
