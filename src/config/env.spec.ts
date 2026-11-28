import { validateEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://app:pw@localhost:5432/yalli',
  REDIS_URL: 'redis://:pw@localhost:6379',
  RABBITMQ_URL: 'amqp://u:pw@localhost:5672',
  JWT_KEY_ID: 'k1',
  JWT_PRIVATE_KEY_B64: 'x'.repeat(100),
  MFA_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
};

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it('rejects key material of the wrong size and inconsistent token lifetimes', () => {
    expect(() =>
      validateEnv({
        ...base,
        MFA_ENCRYPTION_KEY_B64: Buffer.alloc(16)
          .toString('base64')
          .padEnd(40, 'A'),
      }),
    ).toThrow(/MFA_ENCRYPTION_KEY_B64/);
    expect(() =>
      validateEnv({
        ...base,
        REFRESH_IDLE_TTL_DAYS: '40',
        REFRESH_ABSOLUTE_TTL_DAYS: '30',
      }),
    ).toThrow(/REFRESH_IDLE_TTL_DAYS/);
  });

  it('S3 storage needs a bucket name; the prefix is folders ending in "/"', () => {
    expect(() => validateEnv({ ...base, STORAGE_DRIVER: 's3' })).toThrow(
      /S3_BUCKET/,
    );
    expect(
      validateEnv({
        ...base,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'yalli-media',
        S3_PREFIX: 'media/',
      }).S3_BUCKET,
    ).toBe('yalli-media');
    expect(() =>
      validateEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'Bad_Bucket' }),
    ).toThrow(/S3_BUCKET/);
    expect(() =>
      validateEnv({
        ...base,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'yalli-media',
        S3_PREFIX: '../x',
      }),
    ).toThrow(/S3_PREFIX/);
  });

  it('validates payment settings: lengths, windows and the GSTIN format', () => {
    expect(() => validateEnv({ ...base, SELLER_GSTIN: 'not-a-gstin' })).toThrow(
      /SELLER_GSTIN/,
    );
    expect(
      validateEnv({ ...base, SELLER_GSTIN: '33ABCDE1234F1Z7' }).SELLER_GSTIN,
    ).toBe('33ABCDE1234F1Z7');
    // a typo (check character) and a GSTIN from another state than SELLER_STATE are refused
    expect(() =>
      validateEnv({ ...base, SELLER_GSTIN: '33ABCDE1234F1Z5' }),
    ).toThrow(/check character/);
    expect(() =>
      validateEnv({
        ...base,
        SELLER_GSTIN: '29ABCDE1234F1ZW',
        SELLER_STATE: 'Tamil Nadu',
      }),
    ).toThrow(/registered in Karnataka/);
    // the state name is compared without regard to case
    expect(
      validateEnv({
        ...base,
        SELLER_GSTIN: '33ABCDE1234F1Z7',
        SELLER_STATE: 'tamil nadu',
      }).SELLER_GSTIN,
    ).toBe('33ABCDE1234F1Z7');
    expect(() => validateEnv({ ...base, PAYMENT_WINDOW_MINUTES: '1' })).toThrow(
      /PAYMENT_WINDOW_MINUTES/,
    );
    expect(() =>
      validateEnv({ ...base, RAZORPAY_KEY_SECRET: 'short' }),
    ).toThrow(/RAZORPAY_KEY_SECRET/);
    expect(validateEnv(base).EVENT_BUS_DRIVER).toBe('rabbitmq');
  });

  it('fails when required variables are missing', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('never leaks secret values in the error message', () => {
    try {
      validateEnv({
        ...base,
        DATABASE_URL: 'mysql://root:SuperSecret123@db/x',
      });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('DATABASE_URL');
      expect(String(e)).not.toContain('SuperSecret123');
    }
  });

  it.each([
    '*',
    'https://shop.example.com/',
    'shop.example.com',
    'https://a.example.com,*',
  ])(
    'rejects wildcard / non-origin CORS value %s in any environment',
    (value) => {
      expect(() =>
        validateEnv({ ...base, CORS_ALLOWED_ORIGINS: value }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );

  it('parses an exact-origin allow-list', () => {
    const env = validateEnv({
      ...base,
      CORS_ALLOWED_ORIGINS: 'https://yalli.in, http://localhost:5173',
    });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([
      'https://yalli.in',
      'http://localhost:5173',
    ]);
  });

  describe('production guards', () => {
    // every production rule satisfied at once: the guards do not contradict each other
    const complete = {
      ...base,
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/yalli',
      REPORTING_DATABASE_URL: 'postgresql://rep:pw@db.internal:5432/yalli',
      REDIS_URL: 'rediss://:pw@cache.internal:6379',
      RABBITMQ_URL: 'amqps://u:pw@mq.internal:5671',
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://yalli.in',
      DATABASE_SSL: 'true',
      COOKIE_SECURE: 'true',
      TRUST_PROXY_HOPS: '2',
      CAPTCHA_PROVIDER: 'turnstile',
      TURNSTILE_SECRET: '0x4AAAAAAAreal-secret-value',
      HIBP_ENABLED: 'true',
      NOTIFICATIONS_DRIVER: 'ses_msg91',
      SES_FROM_ADDRESS: 'shop@yalli.in',
      MSG91_AUTH_KEY: 'msg91-auth-key-value',
      MSG91_OTP_TEMPLATE_ID: 'tmpl-1',
      MEDIA_BASE_URL: 'https://yalli.in/media',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'yalli-media',
      RAZORPAY_KEY_ID: 'rzp_live_abcdef12',
      RAZORPAY_KEY_SECRET: 'secret_secret_secret_1',
      RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_secret_1',
      SELLER_GSTIN: '33ABCDE1234F1Z7',
      EVENT_BUS_DRIVER: 'rabbitmq',
      FRONTEND_BASE_URL: 'https://yalli.in',
    };
    it('accepts a complete production configuration', () => {
      expect(validateEnv(complete).NODE_ENV).toBe('production');
    });
    it.each([
      ['FRONTEND_BASE_URL', 'http://localhost:3001'],
      ['FRONTEND_BASE_URL', 'http://yalli.in'],
      ['REPORTING_DATABASE_URL', undefined],
      ['REDIS_URL', 'redis://:pw@cache.internal:6379'],
      ['RABBITMQ_URL', 'amqp://u:pw@mq.internal:5672'],
      ['TURNSTILE_SECRET', '1x0000000000000000000000000000000AA'],
      // the app role's own credentials would defeat the read-only reporting role
      ['REPORTING_DATABASE_URL', 'postgresql://app:pw@db.internal:5432/yalli'],
    ])('refuses %s=%s in production', (key, value) => {
      expect(() => validateEnv({ ...complete, [key]: value })).toThrow(
        new RegExp(key),
      );
    });
    it('refuses to start in production when it was given the migrator URL', () => {
      expect(() =>
        validateEnv({
          ...complete,
          DATABASE_MIGRATION_URL: 'postgresql://m:secret@db:5432/yalli',
        }),
      ).toThrow(/DATABASE_MIGRATION_URL: must not be given/);
      expect(() =>
        validateEnv({ ...complete, DATABASE_MIGRATION_URL: '' }),
      ).not.toThrow();
    });
    it('allows the development defaults outside production', () => {
      expect(() =>
        validateEnv({
          ...base,
          CAPTCHA_PROVIDER: 'turnstile',
          TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
        }),
      ).not.toThrow();
    });

    const prod = {
      ...base,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://yalli.in',
      DATABASE_SSL: 'true',
    };

    // The console notification driver prints one-time links: a compliant production config cannot use it yet.
    it('refuses to boot with the dev-only console notification driver', () => {
      expect(() => validateEnv(prod)).toThrow(/NOTIFICATIONS_DRIVER/);
    });
    it('requires Razorpay credentials, the seller GSTIN and the RabbitMQ bus', () => {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ]) {
        const withAll = {
          ...prod,
          RAZORPAY_KEY_ID: 'rzp_live_abcdef12',
          RAZORPAY_KEY_SECRET: 'secret_secret_secret_1',
          RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_secret_1',
        };
        const without: Record<string, string | undefined> = {
          ...withAll,
          [key]: undefined,
        };
        expect(() => validateEnv(without)).toThrow(/RAZORPAY_KEY_ID/);
      }
      expect(() =>
        validateEnv({ ...prod, EVENT_BUS_DRIVER: 'memory' }),
      ).toThrow(/EVENT_BUS_DRIVER/);
      expect(() => validateEnv(prod)).toThrow(/SELLER_GSTIN/);
    });
    it('refuses a localhost or plain-http MEDIA_BASE_URL in production (image links in every page)', () => {
      expect(() => validateEnv(prod)).toThrow(/MEDIA_BASE_URL/);
      for (const url of [
        'http://cdn.yalli.in/media',
        'https://localhost/media',
      ]) {
        try {
          validateEnv({ ...prod, MEDIA_BASE_URL: url });
        } catch (e) {
          expect(String(e)).toMatch(/MEDIA_BASE_URL/);
        }
      }
      try {
        validateEnv({ ...prod, MEDIA_BASE_URL: 'https://media.yalli.in' });
      } catch (e) {
        expect(String(e)).not.toMatch(/MEDIA_BASE_URL/);
      }
    });
    it('refuses TRUST_PROXY_HOPS=0 in production (every client would share the proxy IP)', () => {
      expect(() => validateEnv(prod)).toThrow(/TRUST_PROXY_HOPS/);
      try {
        validateEnv({ ...prod, TRUST_PROXY_HOPS: '2' });
      } catch (e) {
        expect(String(e)).not.toMatch(/TRUST_PROXY_HOPS/);
      }
    });

    it('refuses local-disk image storage in production', () => {
      expect(() => validateEnv({ ...prod, STORAGE_DRIVER: 'local' })).toThrow(
        /STORAGE_DRIVER/,
      );
    });
    it('requires a real captcha, breached-password checks and Secure cookies', () => {
      expect(() => validateEnv({ ...prod, CAPTCHA_PROVIDER: 'none' })).toThrow(
        /CAPTCHA_PROVIDER/,
      );
      expect(() => validateEnv({ ...prod, HIBP_ENABLED: 'false' })).toThrow(
        /HIBP_ENABLED/,
      );
      expect(() => validateEnv({ ...prod, COOKIE_SECURE: 'false' })).toThrow(
        /COOKIE_SECURE/,
      );
    });
    it('requires https CORS origins', () => {
      expect(() =>
        validateEnv({ ...prod, CORS_ALLOWED_ORIGINS: 'http://yalli.in' }),
      ).toThrow(/https/);
      expect(() => validateEnv({ ...prod, CORS_ALLOWED_ORIGINS: '' })).toThrow(
        /CORS_ALLOWED_ORIGINS/,
      );
    });
    it('requires TLS to the database', () => {
      expect(() => validateEnv({ ...prod, DATABASE_SSL: 'false' })).toThrow(
        /DATABASE_SSL/,
      );
    });
    it('forbids pretty logging (dev-only dependency)', () => {
      expect(() => validateEnv({ ...prod, LOG_PRETTY: 'true' })).toThrow(
        /LOG_PRETTY/,
      );
    });
    it('forbids Swagger', () => {
      expect(() => validateEnv({ ...prod, SWAGGER_ENABLED: 'true' })).toThrow(
        /SWAGGER_ENABLED/,
      );
    });
  });

  it('NOTIFICATIONS_DRIVER=ses_msg91 requires the sender identity and the SMS credentials', () => {
    expect(() =>
      validateEnv({ ...base, NOTIFICATIONS_DRIVER: 'ses_msg91' }),
    ).toThrow(/SES_FROM_ADDRESS/);
    const ok = validateEnv({
      ...base,
      NOTIFICATIONS_DRIVER: 'ses_msg91',
      SES_FROM_ADDRESS: 'no-reply@yalli.in',
      MSG91_AUTH_KEY: 'k'.repeat(20),
      MSG91_OTP_TEMPLATE_ID: 'tmpl_1234',
    });
    expect(ok.AWS_REGION).toBe('ap-south-1');
    expect(() =>
      validateEnv({ ...base, NOTIFICATIONS_DRIVER: 'sendgrid' }),
    ).toThrow(/NOTIFICATIONS_DRIVER/);
  });

  it('MFA_RETIRED_KEYS_JSON must be well-formed and must not reuse the current key id', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    expect(
      validateEnv({
        ...base,
        MFA_RETIRED_KEYS_JSON: JSON.stringify({ old1: key }),
      }).MFA_RETIRED_KEYS_JSON,
    ).toContain('old1');
    for (const bad of [
      '[]',
      'not json',
      JSON.stringify({ k1: key }), // same id as the current key
      JSON.stringify({ old: 'short' }),
      JSON.stringify({ 'bad id!': key }),
    ])
      expect(() =>
        validateEnv({ ...base, MFA_RETIRED_KEYS_JSON: bad }),
      ).toThrow(/MFA_RETIRED_KEYS_JSON/);
  });
});
