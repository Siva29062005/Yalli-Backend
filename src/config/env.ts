import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const origins = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

/**
 * Single source of truth for configuration. The process refuses to boot when
 * this fails, and it never echoes secret VALUES in error messages.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Human-readable logs via pino-pretty (a devDependency; never available in the production image). */
    LOG_PRETTY: bool,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Runtime (DML-only) database role. The migrator credential is NOT read by the app.
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Read-only, column-limited role for admin analytics. Optional: without it, reports use DATABASE_URL. */
    REPORTING_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    DATABASE_SSL: bool,

    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),

    CORS_ALLOWED_ORIGINS: origins,
    /** Number of reverse-proxy hops to trust for X-Forwarded-For (0 = none). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    SWAGGER_ENABLED: bool,

    // --- Authentication (Phase 3) ---------------------------------------------------------
    JWT_ISSUER: z.string().min(3).max(200).default('yalli-api'),
    JWT_AUDIENCE: z.string().min(3).max(200).default('yalli-clients'),
    JWT_ACCESS_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3_600)
      .default(900),
    /** Key id of the ACTIVE signing key (published in the JWKS `kid`). */
    JWT_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    /** Ed25519 private key, PKCS#8 PEM, base64-encoded. From the secrets manager in production. */
    JWT_PRIVATE_KEY_B64: z.string().min(80),
    /** Optional retired public keys still accepted for verification: {"<kid>":"<base64 SPKI PEM>"} (rotation window). */
    JWT_RETIRED_PUBLIC_KEYS_JSON: z.string().default('{}'),
    REFRESH_ABSOLUTE_TTL_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30),
    REFRESH_IDLE_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    /** 32 random bytes, base64. Encrypts TOTP secrets at rest (AES-256-GCM). */
    MFA_ENCRYPTION_KEY_B64: z.string().min(40),
    MFA_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,16}$/)
      .default('k1'),
    /**
     * Retired MFA keys, kept for DECRYPTION only while `rotate-mfa-key` re-encrypts the stored secrets:
     * JSON object of keyId -> base64 32-byte key. Remove an entry once nothing is encrypted under it.
     */
    MFA_RETIRED_KEYS_JSON: z.string().default('{}'),
    MFA_ISSUER: z.string().min(1).max(60).default('Yalli'),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CAPTCHA_PROVIDER: z.enum(['none', 'turnstile']).default('none'),
    TURNSTILE_SECRET: z.string().min(10).optional(),
    /** k-anonymity breached-password lookup (sends only a 5-char hash prefix). */
    HIBP_ENABLED: bool,
    /** `console` prints links/codes to stdout for local development ONLY. */
    /** Base URL of the storefront; used to build verification / reset links. */
    FRONTEND_BASE_URL: z.url().default('http://localhost:3001'),
    NOTIFICATIONS_DRIVER: z.enum(['console', 'ses_msg91']).default('console'),
    /** `ses_msg91`: email through Amazon SES (IAM role / default AWS credential chain), OTP SMS through MSG91. */
    AWS_REGION: z.string().min(5).max(30).default('ap-south-1'),
    SES_FROM_ADDRESS: z.string().email().max(254).optional(),
    SES_CONFIGURATION_SET: z.string().min(1).max(64).optional(),
    MSG91_AUTH_KEY: z.string().min(10).max(128).optional(),
    /** DLT-approved flow template with one variable named `otp`. */
    MSG91_OTP_TEMPLATE_ID: z.string().min(4).max(64).optional(),

    /** In-process background jobs (reservation expiry). Tests turn this off and drive jobs explicitly. */
    BACKGROUND_JOBS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Local image storage (development only; production requires an object store). */
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    UPLOADS_DIR: z.string().min(1).default('./storage/uploads'),
    MEDIA_BASE_URL: z.url().default('http://localhost:3000/media'),

    // --- Payments / orders (Phase 5) ------------------------------------------------------------
    RAZORPAY_KEY_ID: z.string().min(8).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(16).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(16).optional(),
    /** Unpaid orders a customer may hold at once (each one reserves stock): stops stock hoarding with throwaway orders. */
    MAX_OPEN_UNPAID_ORDERS: z.coerce.number().int().min(1).max(20).default(3),
    /** How long an unpaid order holds its stock reservation. */
    PAYMENT_WINDOW_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(30),
    /** Returns are accepted this many days after delivery (policy value: confirm with the business). */
    RETURN_WINDOW_DAYS: z.coerce.number().int().min(0).max(90).default(7),
    /** Seller state decides CGST+SGST (same state) vs IGST (other states) on invoices. */
    /** Name printed as the seller on invoices: the registered legal name (as on the GST registration). */
    SELLER_LEGAL_NAME: z.string().min(2).max(120).default('Yalli'),
    SELLER_STATE: z.string().min(2).max(60).default('Tamil Nadu'),
    SELLER_GSTIN: z
      .string()
      .regex(/^[0-9A-Z]{15}$/)
      .optional(),
    /** `rabbitmq` publishes outbox events to the broker; `memory` is for tests/local use without a broker. */
    EVENT_BUS_DRIVER: z.enum(['rabbitmq', 'memory']).default('rabbitmq'),

    REQUEST_BODY_LIMIT_KB: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_240)
      .default(100),
    REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
  })
  .superRefine((env, ctx) => {
    if (env.CAPTCHA_PROVIDER === 'turnstile' && !env.TURNSTILE_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SECRET'],
        message: 'required when CAPTCHA_PROVIDER=turnstile',
      });
    }
    if (env.NOTIFICATIONS_DRIVER === 'ses_msg91') {
      for (const key of [
        'SES_FROM_ADDRESS',
        'MSG91_AUTH_KEY',
        'MSG91_OTP_TEMPLATE_ID',
      ] as const)
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when NOTIFICATIONS_DRIVER=ses_msg91',
          });
    }
    if (Buffer.from(env.MFA_ENCRYPTION_KEY_B64, 'base64').length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY_B64'],
        message: 'must decode to exactly 32 bytes',
      });
    }
    try {
      const retired: unknown = JSON.parse(env.MFA_RETIRED_KEYS_JSON);
      if (
        typeof retired !== 'object' ||
        retired === null ||
        Array.isArray(retired)
      )
        throw new Error('shape');
      for (const [id, key] of Object.entries(retired)) {
        if (
          !/^[A-Za-z0-9_-]{1,16}$/.test(id) ||
          id === env.MFA_ENCRYPTION_KEY_ID ||
          typeof key !== 'string' ||
          Buffer.from(key, 'base64').length !== 32
        )
          throw new Error('entry');
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_RETIRED_KEYS_JSON'],
        message:
          'must be a JSON object of keyId -> base64 32-byte key, with ids different from MFA_ENCRYPTION_KEY_ID',
      });
    }
    if (env.REFRESH_IDLE_TTL_DAYS > env.REFRESH_ABSOLUTE_TTL_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_IDLE_TTL_DAYS'],
        message: 'must not exceed REFRESH_ABSOLUTE_TTL_DAYS',
      });
    }
    try {
      const retired: unknown = JSON.parse(env.JWT_RETIRED_PUBLIC_KEYS_JSON);
      if (
        typeof retired !== 'object' ||
        retired === null ||
        Array.isArray(retired)
      )
        throw new Error('shape');
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_RETIRED_PUBLIC_KEYS_JSON'],
        message: 'must be a JSON object of kid -> base64 PEM',
      });
    }
    for (const o of env.CORS_ALLOWED_ORIGINS) {
      let ok = false;
      try {
        ok = o !== '*' && new URL(o).origin === o;
      } catch {
        ok = false;
      }
      if (!ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message:
            'must be a comma-separated list of exact origins (no wildcards, no paths)',
        });
        break;
      }
    }
    if (env.NODE_ENV === 'production') {
      if (
        env.CORS_ALLOWED_ORIGINS.length === 0 ||
        env.CORS_ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'production requires a non-empty list of https:// origins',
        });
      }
      if (!env.DATABASE_SSL) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_SSL'],
          message: 'must be true in production',
        });
      }
      if (env.LOG_PRETTY) {
        ctx.addIssue({
          code: 'custom',
          path: ['LOG_PRETTY'],
          message: 'must be false in production',
        });
      }
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (env.CAPTCHA_PROVIDER === 'none') {
        ctx.addIssue({
          code: 'custom',
          path: ['CAPTCHA_PROVIDER'],
          message: 'a real captcha provider is required in production',
        });
      }
      if (!env.HIBP_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['HIBP_ENABLED'],
          message: 'must be true in production',
        });
      }
      if (env.NOTIFICATIONS_DRIVER === 'console') {
        ctx.addIssue({
          code: 'custom',
          path: ['NOTIFICATIONS_DRIVER'],
          message:
            'console driver prints secrets; set NOTIFICATIONS_DRIVER=ses_msg91',
        });
      }
      if (env.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message:
            'local disk storage is development only; configure an object store',
        });
      }
      if (
        !env.RAZORPAY_KEY_ID ||
        !env.RAZORPAY_KEY_SECRET ||
        !env.RAZORPAY_WEBHOOK_SECRET
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['RAZORPAY_KEY_ID'],
          message:
            'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required in production',
        });
      }
      if (!env.SELLER_GSTIN) {
        ctx.addIssue({
          code: 'custom',
          path: ['SELLER_GSTIN'],
          message: 'required in production (tax invoices)',
        });
      }
      if (env.EVENT_BUS_DRIVER !== 'rabbitmq') {
        ctx.addIssue({
          code: 'custom',
          path: ['EVENT_BUS_DRIVER'],
          message: 'must be rabbitmq in production',
        });
      }
      if (env.SWAGGER_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['SWAGGER_ENABLED'],
          message: 'must be false in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Report variable names + rule messages only; never the offending values.
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
