import { checkLaunchConfig, parseEnvFile } from './launch-config.js';

const frontend = {
  NEXT_PUBLIC_BUSINESS_LEGAL_NAME: 'Yalli Marketing Private Limited',
  NEXT_PUBLIC_BUSINESS_ADDRESS: '12 Lake Road, Madurai 625001, Tamil Nadu',
  NEXT_PUBLIC_BUSINESS_GSTIN: '33ABCDE1234F1Z7',
  NEXT_PUBLIC_BUSINESS_SELLER_STATE: 'Tamil Nadu',
  NEXT_PUBLIC_BUSINESS_WEBSITE_URL: 'https://shop.example.test',
  NEXT_PUBLIC_BUSINESS_SUPPORT_EMAIL: 'help@example.test',
  NEXT_PUBLIC_BUSINESS_SUPPORT_PHONE: '+91 98765 43210',
  NEXT_PUBLIC_BUSINESS_SUPPORT_HOURS: 'Mon-Sat 10:00-18:00',
  NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_NAME: 'A. Kumar',
  NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_DESIGNATION: 'Director',
  NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_EMAIL: 'grievance@example.test',
  NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_PHONE: '+91 98765 43211',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAA',
  FRONTEND_SERVER_KEY: 'k'.repeat(40),
};
const backend = {
  SELLER_GSTIN: '33ABCDE1234F1Z7',
  SELLER_STATE: 'Tamil Nadu',
  SELLER_LEGAL_NAME: 'Yalli Marketing Private Limited',
  FRONTEND_BASE_URL: 'https://shop.example.test',
  SUPPORT_INBOX_EMAIL: 'help@example.test',
  FRONTEND_SERVER_KEY: 'k'.repeat(40),
};

describe('launch configuration check', () => {
  it('passes a complete, consistent configuration', () => {
    expect(checkLaunchConfig(backend, frontend)).toEqual({
      errors: [],
      warnings: [],
    });
  });
  it('blocks missing details, a GSTIN typo, mismatches between the apps, and localhost links', () => {
    const r = checkLaunchConfig(
      {
        ...backend,
        SELLER_GSTIN: '33ABCDE1234F1Z5',
        FRONTEND_BASE_URL: 'http://localhost:3001',
        FRONTEND_SERVER_KEY: 'x',
      },
      {
        ...frontend,
        NEXT_PUBLIC_BUSINESS_ADDRESS: '',
        NEXT_PUBLIC_BUSINESS_WEBSITE_URL: 'http://shop.example.test/home',
        NEXT_PUBLIC_BUSINESS_SELLER_STATE: 'Kerala',
      },
    );
    const all = r.errors.join('\n');
    expect(all).toMatch(/NEXT_PUBLIC_BUSINESS_ADDRESS is not set/);
    expect(all).toMatch(/backend: the GSTIN the check character is wrong/);
    expect(all).toMatch(/differs from the one on invoices \(SELLER_GSTIN\)/);
    expect(all).toMatch(/seller state on the pages .* differs/);
    expect(all).toMatch(/must use https/);
    expect(all).toMatch(/bare site address/);
    expect(all).toMatch(
      /FRONTEND_BASE_URL is not the public storefront address/,
    );
    expect(all).toMatch(/FRONTEND_SERVER_KEY must be set to the same value/);
  });
  it('a GSTIN from another state than SELLER_STATE is an error; the default legal name is a warning', () => {
    const r = checkLaunchConfig(
      {
        ...backend,
        SELLER_GSTIN: '29ABCDE1234F1ZW',
        SELLER_LEGAL_NAME: 'Yalli',
      },
      {
        ...frontend,
        NEXT_PUBLIC_BUSINESS_GSTIN: '29ABCDE1234F1ZW',
        NEXT_PUBLIC_BUSINESS_LEGAL_NAME: 'Yalli',
      },
    );
    expect(r.errors.join('\n')).toMatch(
      /registered in another state than SELLER_STATE/,
    );
    expect(r.warnings.join('\n')).toMatch(/SELLER_LEGAL_NAME is the default/);
  });
  it('blocks a report-only CSP build (staging only)', () => {
    const r = checkLaunchConfig(backend, { ...frontend, CSP_REPORT_ONLY: '1' });
    expect(r.errors).toEqual([expect.stringContaining('CSP_REPORT_ONLY')]);
  });

  it('reads .env files', () => {
    expect(
      parseEnvFile('# c\nA=1\nexport B="two words"\n  C = \'x\'\nbad line\n'),
    ).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
  it('never crashes on a broken URL, ignores state case, and accepts a runtime-only server key (with a warning)', () => {
    const r = checkLaunchConfig(
      { ...backend, FRONTEND_BASE_URL: 'yalli.in', SELLER_STATE: 'tamil nadu' },
      { ...frontend, FRONTEND_SERVER_KEY: undefined },
    );
    expect(r.errors).toEqual(['backend: FRONTEND_BASE_URL is not a URL']);
    expect(r.warnings.join('\n')).toMatch(
      /FRONTEND_SERVER_KEY is not in this file/,
    );
  });
  it('prints no setting values', () => {
    const r = checkLaunchConfig(
      {
        ...backend,
        FRONTEND_BASE_URL: 'https://wrong.example.test',
        SELLER_STATE: 'Kerala',
      },
      frontend,
    );
    const out = [...r.errors, ...r.warnings].join('\n');
    for (const value of [
      'wrong.example.test',
      'Kerala',
      '33ABCDE1234F1Z7',
      'shop.example.test',
    ])
      expect(out).not.toContain(value);
  });
});
