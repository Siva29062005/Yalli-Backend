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
  if (!(err instanceof Error)) return err;
  if (err.name === 'PrismaClientValidationError')
    return {
      type: err.name,
      message: 'Prisma validation error (arguments not logged)',
    };
  return stdSerializers.err(err);
}
