import { stdSerializers } from 'pino';

/**
 * Values that must never reach the logs. Named precisely: a broad `*.code` also hid error codes (`err.code`: P2002,
 * ECONNREFUSED) that are needed to diagnose an incident. Request bodies are never logged at all.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-api-key"]',
  'req.headers["x-frontend-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.mfaToken',
  '*.captchaToken',
  '*.recoveryCode',
  '*.otp',
  '*.otpCode',
  '*.totpCode',
  '*.secret',
  '*.cardNumber',
  '*.cvv',
];

/**
 * Error serializer: the standard one, except for Prisma validation errors, whose message (and stack, which starts with
 * it) prints the query's ARGUMENTS: personal data, password hashes. Their kind is logged, not their text.
 */
export function serializeError(err: unknown): unknown {
  // pino-http (nestjs-pino) WRAPS this serializer: it receives the standard serializer's plain object, not the Error.
  // Both shapes are handled; the test goes through pino-http like the app.
  const PRISMA_VALIDATION = 'PrismaClientValidationError';
  const o = (typeof err === 'object' && err !== null ? err : {}) as {
    type?: unknown;
    name?: unknown;
  };
  const isPrismaValidation =
    (err instanceof Error && err.name === PRISMA_VALIDATION) ||
    o.type === PRISMA_VALIDATION ||
    o.name === PRISMA_VALIDATION;
  const kind = isPrismaValidation ? PRISMA_VALIDATION : '';
  if (kind === 'PrismaClientValidationError')
    return {
      type: kind,
      message: 'Prisma validation error (arguments not logged)',
    };
  return err instanceof Error ? stdSerializers.err(err) : err;
}
