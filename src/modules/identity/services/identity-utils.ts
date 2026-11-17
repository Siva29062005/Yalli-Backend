import { createHash } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '../../../common/exceptions/error-codes.js';

export const normalizeEmail = (email: string): string =>
  email.normalize('NFKC').trim().toLowerCase();

export const deviceHash = (userAgent: string | null): string =>
  createHash('sha256')
    .update((userAgent ?? '').slice(0, 512))
    .digest('hex');

/** Same message and code for unknown user, wrong password, locked account, deleted account. */
export const invalidCredentials = (): UnauthorizedException =>
  new UnauthorizedException({
    message: 'Invalid email or password',
    code: ErrorCode.Unauthorized,
  });

export const apiError = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException => new HttpException({ message, code, ...extra }, status);

export const displayName = (
  c: { firstName: string; lastName: string } | null | undefined,
): string => (c ? `${c.firstName} ${c.lastName}`.trim() : 'there');

export const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: string } | null)?.code === 'P2002';

export const addMinutes = (d: Date, m: number): Date =>
  new Date(d.getTime() + m * 60_000);
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getTime() + n * 86_400_000);
