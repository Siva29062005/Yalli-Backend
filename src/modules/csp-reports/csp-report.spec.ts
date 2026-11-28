import { describe, expect, it } from 'vitest';
import { cspReportSchema, safeUrl, toViolation } from './csp-report.js';

describe('CSP report sanitising', () => {
  it('keeps only origin and path: tokens in query strings never reach the log', () => {
    expect(safeUrl('https://yalli.in/auth/reset-password?token=SECRET#x')).toBe(
      'https://yalli.in/auth/reset-password',
    );
    expect(safeUrl('inline')).toBe('inline');
    expect(safeUrl('eval')).toBe('eval');
    expect(safeUrl('data:text/html;base64,AAAA')).toBe('data:');
    expect(safeUrl('not a url <script>')).toBe('other');
    expect(safeUrl(undefined)).toBe('-');
  });

  it('replaces control characters and caps the length', () => {
    const v = safeUrl(`https://evil.example/${'a'.repeat(500)}\n`);
    expect(v.length).toBeLessThanOrEqual(120);
    expect(v).not.toMatch(/\n/);
  });

  it('reads the classic report-uri body', () => {
    const body = cspReportSchema.parse({
      'csp-report': {
        'document-uri': 'https://yalli.in/checkout?x=1',
        'blocked-uri': 'https://cdn.evil.example/x.js?k=v',
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'original-policy': "default-src 'self'",
        disposition: 'enforce',
        'status-code': 200,
      },
    });
    expect(toViolation(body)).toEqual({
      directive: 'script-src-elem',
      blocked: 'https://cdn.evil.example/x.js',
      page: 'https://yalli.in/checkout',
      source: '-',
      disposition: 'enforce',
    });
  });

  it('accepts the null fields browsers send when they cannot report a value', () => {
    const body = cspReportSchema.parse({
      'csp-report': {
        'document-uri': 'https://yalli.in/',
        'blocked-uri': null,
        'source-file': null,
        'violated-directive': 'script-src-elem https://x',
      },
    });
    expect(toViolation(body)).toMatchObject({
      directive: 'script-src-elem',
      blocked: '-',
      source: '-',
    });
  });

  it('refuses anything else', () => {
    expect(cspReportSchema.safeParse({ hello: 'world' }).success).toBe(false);
    // the Reporting API array format is not used by our policy
    expect(
      cspReportSchema.safeParse([{ type: 'csp-violation', body: {} }]).success,
    ).toBe(false);
  });
});
