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
