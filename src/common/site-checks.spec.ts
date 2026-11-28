import { describe, expect, it } from 'vitest';
import {
  cacheFindings,
  corsFindings,
  cspFindings,
  envelopeFindings,
  errorBodyFindings,
  pageHeaderFindings,
  robotsFindings,
  sitemapFindings,
  summarise,
} from './site-checks.js';

const headers = (h: Record<string, string>) => new Headers(h);
const failed = (fs: { level: string; check: string }[]) =>
  fs.filter((f) => f.level === 'fail').map((f) => f.check);

const GOOD_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://*.razorpay.com; object-src 'none'; frame-ancestors 'none'; report-uri /api/v1/csp-reports";
const goodPage = {
  'content-security-policy': GOOD_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

describe('site checks', () => {
  it('passes a correctly configured page', () => {
    const fs = pageHeaderFindings(headers(goodPage), {
      https: true,
      where: '/',
    });
    expect(failed(fs)).toEqual([]);
    expect(summarise(fs)).toEqual({ failed: 0, warned: 0 });
  });

  it('fails missing headers, a short HSTS and a framework banner', () => {
    const fs = pageHeaderFindings(
      headers({
        'strict-transport-security': 'max-age=300',
        'x-powered-by': 'Next.js',
      }),
      { https: true, where: '/' },
    );
    expect(failed(fs)).toEqual([
      '/: CSP enforced',
      '/: X-Content-Type-Options',
      '/: X-Frame-Options',
      '/: Referrer-Policy',
      '/: HSTS',
      '/: no X-Powered-By',
    ]);
  });

  it('warns on a report-only CSP but still checks its content', () => {
    const fs = pageHeaderFindings(
      headers({
        ...goodPage,
        'content-security-policy': '',
        'content-security-policy-report-only': GOOD_CSP,
      }),
      { https: false, where: '/' },
    );
    expect(summarise(fs)).toEqual({ failed: 0, warned: 1 });
    // on production the same answer is a failure
    const prod = pageHeaderFindings(
      headers({
        ...goodPage,
        'content-security-policy': '',
        'content-security-policy-report-only': GOOD_CSP,
      }),
      { https: false, where: '/', production: true },
    );
    expect(failed(prod)).toEqual(['/: CSP enforced']);
  });

  it('fails a weak CSP', () => {
    const fs = cspFindings(
      "default-src *; script-src 'self' 'unsafe-eval' https:",
      '/',
    );
    expect(failed(fs)).toEqual([
      "/: CSP frame-ancestors 'none'",
      "/: CSP object-src 'none'",
      "/: CSP default-src 'self'",
      "/: CSP script-src without 'unsafe-eval'",
      '/: CSP script-src names its hosts',
    ]);
    expect(summarise(fs).warned).toBe(1); // no report-uri
  });

  it('requires no-store on private API answers and allows public caching for the catalogue', () => {
    expect(
      failed(cacheFindings(headers({}), { where: 'me', cacheable: false })),
    ).toEqual(['me: Cache-Control no-store']);
    expect(
      failed(
        cacheFindings(headers({ 'cache-control': 'no-store' }), {
          where: 'me',
          cacheable: false,
        }),
      ),
    ).toEqual([]);
    expect(
      summarise(
        cacheFindings(headers({ 'cache-control': 'public, max-age=60' }), {
          where: 'cat',
          cacheable: true,
        }),
      ),
    ).toEqual({ failed: 0, warned: 0 });
  });

  it('accepts a clean error envelope and spots leaks', () => {
    const clean = JSON.stringify({
      success: false,
      message: 'Not found',
      error: { code: 'NOT_FOUND' },
      requestId: 'r1',
    });
    expect(
      failed(errorBodyFindings(404, clean, { where: 'x', expectStatus: 404 })),
    ).toEqual([]);
    for (const leak of [
      'Error: boom\n    at Object.<anonymous> (/app/dist/main.js:10:5)',
      '{"stack":"..."}',
      'Cannot GET /api/v1/x',
      'PrismaClientKnownRequestError P2002',
      '<!DOCTYPE html><html>',
      'SELECT id FROM users WHERE 1',
    ])
      expect(
        failed(errorBodyFindings(500, leak, { where: 'x', expectStatus: 404 })),
      ).toEqual([
        'x: answers 404',
        'x: error envelope',
        'x: nothing internal in the error',
      ]);
  });

  it('checks the success envelope', () => {
    expect(
      failed(envelopeFindings('{"success":true,"requestId":"r"}', 'c')),
    ).toEqual([]);
    expect(failed(envelopeFindings('[]', 'c'))).toEqual([
      'c: success envelope',
    ]);
  });

  it('fails CORS that lets a foreign origin in', () => {
    const o = 'https://verify-site.invalid';
    expect(failed(corsFindings(headers({}), o, 'cors'))).toEqual([]);
    expect(
      failed(
        corsFindings(headers({ 'access-control-allow-origin': o }), o, 'cors'),
      ),
    ).toEqual(['cors: foreign origin refused']);
    expect(
      failed(
        corsFindings(
          headers({ 'access-control-allow-origin': '*' }),
          o,
          'cors',
        ),
      ),
    ).toEqual(['cors: foreign origin refused']);
  });

  it('checks robots.txt and the sitemap host', () => {
    const robots =
      'User-Agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /checkout\n';
    expect(failed(robotsFindings(robots))).toEqual([]);
    expect(failed(robotsFindings('User-Agent: *\nAllow: /'))).toHaveLength(3);
    const site = 'https://yalli.in';
    expect(
      failed(
        sitemapFindings(
          `<urlset><url><loc>${site}</loc></url><url><loc>${site}/help</loc></url></urlset>`,
          site,
        ),
      ),
    ).toEqual([]);
    expect(
      failed(
        sitemapFindings(
          '<urlset><url><loc>https://shop.example.test/help</loc></url></urlset>',
          site,
        ),
      ),
    ).toEqual(['sitemap.xml uses this site address']);
    expect(failed(sitemapFindings('<urlset></urlset>', site))).toEqual([
      'sitemap.xml lists pages',
    ]);
  });
});
