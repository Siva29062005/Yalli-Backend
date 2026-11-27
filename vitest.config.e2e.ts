import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Throwaway keys, generated per run, never persisted or committed.
const { privateKey } = generateKeyPairSync('ed25519');
const jwtPrivateKeyB64 = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
).toString('base64');

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Test files share one PostgreSQL; each file uses unique data, so files can run in parallel.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://u:pw@localhost:5672',
      CORS_ALLOWED_ORIGINS: 'https://allowed.example.com',
      REQUEST_BODY_LIMIT_KB: '1',
      // One proxy hop: tests set X-Forwarded-For to get a distinct client IP (and so distinct rate-limit buckets).
      TRUST_PROXY_HOPS: '1',
      // The storefront server's shared key (rate-limit budget for its server-side catalogue reads).
      FRONTEND_SERVER_KEY: 'test-frontend-server-key-0123456789abcdef',
      COOKIE_SECURE: 'false',
      BACKGROUND_JOBS_ENABLED: 'false',
      EVENT_BUS_DRIVER: 'memory',
      RAZORPAY_KEY_ID: 'rzp_test_AbCdEf1234',
      RAZORPAY_KEY_SECRET: 'test_key_secret_0123456789abcdef',
      RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret_0123456789ab',
      SELLER_STATE: 'Tamil Nadu',
      PAYMENT_WINDOW_MINUTES: '30',
      UPLOADS_DIR: join(
        tmpdir(),
        `yalli-test-uploads-${randomBytes(4).toString('hex')}`,
      ),
      JWT_KEY_ID: 'test-key-1',
      JWT_PRIVATE_KEY_B64: jwtPrivateKeyB64,
      MFA_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64'),
    },
  },
});
