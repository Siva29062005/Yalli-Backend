import { describe, expect, it } from 'vitest';
import { cspReportSchema, safeUrl, toViolations } from './csp-report.js';

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
    expect(toViolations(body)).toEqual([
      {
        directive: 'script-src-elem',
        blocked: 'https://cdn.evil.example/x.js',
        page: 'https://yalli.in/checkout',
        source: '-',
        disposition: 'enforce',
      },
    ]);
  });

  it('reads the Reporting API array and ignores other report types', () => {
    const body = cspReportSchema.parse([
      {
        type: 'csp-violation',
        age: 1,
        url: 'https://yalli.in/',
        body: {
          documentURL: 'https://yalli.in/',
          blockedURL: 'inline',
          effectiveDirective: 'script-src-elem',
          disposition: 'report',
        },
      },
      { type: 'deprecation', body: {} },
    ]);
    expect(toViolations(body)).toEqual([
      {
        directive: 'script-src-elem',
        blocked: 'inline',
        page: 'https://yalli.in/',
        source: '-',
        disposition: 'report',
      },
    ]);
  });

  it('refuses anything else', () => {
    expect(cspReportSchema.safeParse({ hello: 'world' }).success).toBe(false);
    expect(
      cspReportSchema.safeParse(
        Array.from({ length: 21 }, () => ({ type: 'csp-violation' })),
      ).success,
    ).toBe(false);
  });
});
