import { Logger } from '@nestjs/common';
import {
  Scenario,
  authed,
  createTestApp,
  freshIp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
});
afterAll(() => ctx.close());

describe('Cache-Control (nothing personal in a browser or CDN cache)', () => {
  it('answers no-store by default: signed-in data, errors and auth answers', async () => {
    const customer = await s.session();
    const me = await ctx.http().get('/api/v1/me').set(authed(customer));
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    const anonymous = await ctx.http().get('/api/v1/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: 'nobody@example.test', password: 'wrong-password-1' });
    expect(login.headers['cache-control']).toBe('no-store');
    const missing = await ctx.http().get('/api/v1/no-such-route');
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it('keeps the public catalogue cacheable', async () => {
    const res = await ctx.http().get('/api/v1/catalog/categories');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('never lets an error on a cacheable route be cached', async () => {
    const missing = await ctx
      .http()
      .get('/api/v1/catalog/products/no-such-product-slug');
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    const bad = await ctx.http().get('/api/v1/catalog/compare?slugs=a');
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe('no-store');
  });
});

describe('CSP violation reports', () => {
  const post = (body: unknown, type: string, ip = freshIp()) =>
    ctx
      .http()
      .post('/api/v1/csp-reports')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', type)
      .send(JSON.stringify(body));
  const classic = {
    'csp-report': {
      'document-uri': 'https://shop.example.test/auth/reset-password?token=t',
      'blocked-uri': 'https://evil.example/x.js',
      'effective-directive': 'script-src-elem',
      disposition: 'enforce',
    },
  };

  it('accepts a report anonymously and logs a sanitised line', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      expect((await post(classic, 'application/csp-report')).status).toBe(204);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('CSP violation');
      expect(logged).toContain('https://shop.example.test/auth/reset-password');
      expect(logged).not.toContain('token=');
    } finally {
      warn.mockRestore();
    }
  });

  it('parses application/csp-report on the report route only (other sites can make browsers send it anywhere)', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .set('Content-Type', 'application/csp-report')
      .send(
        JSON.stringify({
          email: 'nobody@example.test',
          password: 'x'.repeat(12),
        }),
      );
    // the body is not parsed, so the login schema sees nothing
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a body that is not a report, and an oversized one', async () => {
    expect(
      (await post({ hello: 'world' }, 'application/csp-report')).status,
    ).toBe(400);
    const big = {
      'csp-report': { 'document-uri': `https://x.test/${'a'.repeat(2000)}` },
    };
    expect((await post(big, 'application/csp-report')).status).toBe(413);
  });

  it('is limited per IP', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++)
      statuses.push((await post(classic, 'application/csp-report', ip)).status);
    expect(statuses.slice(0, 30).every((c) => c === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("does not use up the visitor's shop budget (a CSP mistake must not lock shoppers out)", async () => {
    const ip = freshIp();
    for (let i = 0; i < 310; i++)
      await post(classic, 'application/csp-report', ip);
    const shop = await ctx
      .http()
      .get('/api/v1/catalog/categories')
      .set('X-Forwarded-For', ip);
    expect(shop.status).toBe(200);
  });
});
