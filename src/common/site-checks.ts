/**
 * Read-only checks of a DEPLOYED site (staging or production), judged from HTTP answers only: security headers, the
 * CSP, caching of API answers, error bodies, CORS, search-engine rules and leftover files. Pure functions (unit-tested);
 * `npm run verify:site` (src/cli/verify-site.ts) makes the requests. Nothing here signs in, writes or sends a secret.
 */
export type Level = 'pass' | 'warn' | 'fail';
export interface Finding {
  check: string;
  level: Level;
  detail?: string;
}
/** The part of the Fetch `Headers` interface the checks need. */
export interface HeaderBag {
  get(name: string): string | null;
}

const ONE_YEAR = 31_536_000;
const pass = (check: string): Finding => ({ check, level: 'pass' });
const fail = (check: string, detail: string): Finding => ({
  check,
  level: 'fail',
  detail,
});
const warn = (check: string, detail: string): Finding => ({
  check,
  level: 'warn',
  detail,
});

/** The directives a Content-Security-Policy must contain on this site. */
export function cspFindings(policy: string, where: string): Finding[] {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  const has = (d: string, v: string) => directives.get(d)?.includes(v) ?? false;
  const out: Finding[] = [];
  const need = (d: string, v: string) =>
    out.push(
      has(d, v)
        ? pass(`${where}: CSP ${d} ${v}`)
        : fail(`${where}: CSP ${d} ${v}`, `missing from the policy`),
    );
  need('frame-ancestors', "'none'");
  need('object-src', "'none'");
  need('default-src', "'self'");
  const scripts = directives.get('script-src') ?? [];
  out.push(
    scripts.includes("'unsafe-eval'")
      ? fail(
          `${where}: CSP script-src without 'unsafe-eval'`,
          "'unsafe-eval' is only for development builds",
        )
      : pass(`${where}: CSP script-src without 'unsafe-eval'`),
  );
  out.push(
    scripts.includes('*') || scripts.includes('https:')
      ? fail(`${where}: CSP script-src names its hosts`, 'allows any host')
      : pass(`${where}: CSP script-src names its hosts`),
  );
  out.push(
    directives.has('report-uri') || directives.has('report-to')
      ? pass(`${where}: CSP reports violations`)
      : warn(
          `${where}: CSP reports violations`,
          'no report-uri: blocked scripts go unnoticed',
        ),
  );
  return out;
}

/** Headers every storefront page must carry. */
export function pageHeaderFindings(
  h: HeaderBag,
  opts: { https: boolean; where: string; production?: boolean },
): Finding[] {
  const { where } = opts;
  const out: Finding[] = [];
  const enforced = h.get('content-security-policy');
  const reportOnly = h.get('content-security-policy-report-only');
  if (enforced) out.push(...cspFindings(enforced, where));
  else if (reportOnly) {
    out.push(
      opts.production
        ? fail(
            `${where}: CSP enforced`,
            'report-only (CSP_REPORT_ONLY=1) on production: nothing is blocked',
          )
        : warn(
            `${where}: CSP enforced`,
            'report-only (CSP_REPORT_ONLY=1): fine for a first staging build, never for production',
          ),
    );
    out.push(...cspFindings(reportOnly, where));
  } else out.push(fail(`${where}: CSP enforced`, 'no Content-Security-Policy'));
  out.push(
    h.get('x-content-type-options')?.toLowerCase() === 'nosniff'
      ? pass(`${where}: X-Content-Type-Options`)
      : fail(`${where}: X-Content-Type-Options`, 'not nosniff'),
  );
  out.push(
    h.get('x-frame-options')?.toUpperCase() === 'DENY'
      ? pass(`${where}: X-Frame-Options`)
      : fail(`${where}: X-Frame-Options`, 'not DENY'),
  );
  out.push(
    h.get('referrer-policy')
      ? pass(`${where}: Referrer-Policy`)
      : fail(`${where}: Referrer-Policy`, 'missing'),
  );
  out.push(...commonFindings(h, opts));
  return out;
}

/** HSTS on https and no framework banner: pages and API alike. */
export function commonFindings(
  h: HeaderBag,
  { https, where }: { https: boolean; where: string },
): Finding[] {
  const out: Finding[] = [];
  if (https) {
    const m = /max-age=(\d+)/i.exec(h.get('strict-transport-security') ?? '');
    out.push(
      m && Number(m[1]) >= ONE_YEAR
        ? pass(`${where}: HSTS`)
        : fail(`${where}: HSTS`, 'missing or shorter than a year'),
    );
  }
  out.push(
    h.get('x-powered-by')
      ? fail(`${where}: no X-Powered-By`, 'the framework is announced')
      : pass(`${where}: no X-Powered-By`),
  );
  return out;
}

/** API answers: no-store unless the route is the public catalogue. */
export function cacheFindings(
  h: HeaderBag,
  { where, cacheable }: { where: string; cacheable: boolean },
): Finding[] {
  const cc = (h.get('cache-control') ?? '').toLowerCase();
  if (cacheable)
    return [
      cc.includes('public') && !cc.includes('no-store')
        ? pass(`${where}: cacheable by the CDN`)
        : warn(`${where}: cacheable by the CDN`, `Cache-Control "${cc}"`),
    ];
  return [
    cc.includes('no-store')
      ? pass(`${where}: Cache-Control no-store`)
      : fail(
          `${where}: Cache-Control no-store`,
          `"${cc || 'none'}": a browser or CloudFront may keep it`,
        ),
  ];
}

/** Anything in an error body that betrays the stack, the database or the framework. */
const LEAKS: [RegExp, string][] = [
  [/\bat [\w.<>]+ \(?[^)\s]*:\d+:\d+\)?/, 'a stack trace'],
  [/"stack"\s*:/, 'a stack field'],
  [/node_modules|\/app\/dist\//, 'a server path'],
  [/prisma|PrismaClient|P20\d\d/i, 'a database error'],
  [/\b(SELECT|INSERT|UPDATE)\s.+\s(FROM|INTO|SET)\s/i, 'SQL'],
  [/Cannot (GET|POST|PUT|PATCH|DELETE) \//, "Express's default message"],
  [/<!DOCTYPE html>|<html/i, 'an HTML error page'],
];

/** An API error: the envelope `{ success: false, error: { code } }` and nothing internal. */
export function errorBodyFindings(
  status: number,
  body: string,
  { where, expectStatus }: { where: string; expectStatus: number },
): Finding[] {
  const out: Finding[] = [];
  out.push(
    status === expectStatus
      ? pass(`${where}: answers ${expectStatus}`)
      : fail(`${where}: answers ${expectStatus}`, `got ${status}`),
  );
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // not JSON: reported below
  }
  const env = parsed as {
    success?: unknown;
    error?: { code?: unknown };
    requestId?: unknown;
  } | null;
  out.push(
    env?.success === false &&
      typeof env.error?.code === 'string' &&
      typeof env.requestId === 'string'
      ? pass(`${where}: error envelope`)
      : fail(
          `${where}: error envelope`,
          'not { success: false, error.code, requestId }',
        ),
  );
  const leaks = LEAKS.filter(([re]) => re.test(body)).map(([, what]) => what);
  out.push(
    leaks.length
      ? fail(`${where}: nothing internal in the error`, leaks.join(', '))
      : pass(`${where}: nothing internal in the error`),
  );
  return out;
}

/** A successful API answer in the envelope. */
export function envelopeFindings(body: string, where: string): Finding[] {
  try {
    const env = JSON.parse(body) as { success?: unknown; requestId?: unknown };
    if (env.success === true && typeof env.requestId === 'string')
      return [pass(`${where}: success envelope`)];
  } catch {
    // fall through
  }
  return [
    fail(`${where}: success envelope`, 'not { success: true, requestId }'),
  ];
}

/** A preflight from a foreign origin must not be allowed. */
export function corsFindings(
  h: HeaderBag,
  foreignOrigin: string,
  where: string,
): Finding[] {
  const allowed = h.get('access-control-allow-origin');
  return [
    allowed === '*' || allowed === foreignOrigin
      ? fail(`${where}: foreign origin refused`, `allowed "${allowed}"`)
      : pass(`${where}: foreign origin refused`),
  ];
}

/** robots.txt keeps private areas out; the sitemap lists only this site's pages. */
export function robotsFindings(text: string): Finding[] {
  return ['/admin', '/account', '/checkout'].map((p) =>
    new RegExp(`^Disallow:\\s*${p}`, 'mi').test(text)
      ? pass(`robots.txt disallows ${p}`)
      : fail(`robots.txt disallows ${p}`, 'missing'),
  );
}

export function sitemapFindings(xml: string, origin: string): Finding[] {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(
    (m) => m[1]!,
  );
  if (locs.length === 0)
    return [fail('sitemap.xml lists pages', 'no <loc> entries')];
  const foreign = locs.filter(
    (l) => !l.startsWith(`${origin}/`) && l !== origin,
  );
  return [
    pass(`sitemap.xml lists pages (${locs.length})`),
    foreign.length
      ? fail(
          'sitemap.xml uses this site address',
          `${foreign.length} entries on another host (NEXT_PUBLIC_BUSINESS_WEBSITE_URL)`,
        )
      : pass('sitemap.xml uses this site address'),
  ];
}

export function summarise(findings: Finding[]): {
  failed: number;
  warned: number;
} {
  return {
    failed: findings.filter((f) => f.level === 'fail').length,
    warned: findings.filter((f) => f.level === 'warn').length,
  };
}
