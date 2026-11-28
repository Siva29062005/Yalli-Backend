import {
  cacheFindings,
  commonFindings,
  corsFindings,
  envelopeFindings,
  errorBodyFindings,
  pageHeaderFindings,
  robotsFindings,
  sitemapFindings,
  summarise,
  type Finding,
} from '../common/site-checks.js';

/**
 * Read-only check of a deployed site (staging, and production after go-live): security headers, CSP, HTTPS redirect,
 * caching, error bodies, CORS, robots/sitemap, Swagger off, leftover files. It never signs in and never changes data,
 * so it is safe against production. Run after every deploy (scripts/deploy.sh does when SITE_URL is set).
 *
 *   node dist/cli/verify-site.js --url https://staging.yalli.in [--production] [--allow-http]
 *
 * --production turns warnings that are acceptable on staging (a report-only CSP) into failures. Swagger is not checked
 * here: it is mounted outside /api/v1, which CloudFront never sends to the API, and production refuses SWAGGER_ENABLED.
 * (Run `npm run build` first: the command runs the compiled file.)
 *
 * Exit code 1 when any check fails. Warnings need a decision but do not fail.
 */
const USAGE =
  'Usage: node dist/cli/verify-site.js --url <https://site> [--production] [--allow-http]\n';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FOREIGN_ORIGIN = 'https://verify-site.invalid';

async function get(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      ...init,
      headers: { 'user-agent': 'yalli-verify-site', ...init.headers },
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (err) {
    // TLS errors (a bad certificate) land here too: report the kind, not a stack
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    process.stdout.write(
      `  (request to ${new URL(url).pathname} failed: ${cause ?? (err as Error).name})\n`,
    );
    return null;
  }
}

async function main(): Promise<number> {
  const raw = arg('url');
  if (!raw) {
    process.stderr.write(USAGE);
    return 2;
  }
  let site: URL;
  try {
    site = new URL(raw);
  } catch {
    process.stderr.write(USAGE);
    return 2;
  }
  const https = site.protocol === 'https:';
  if (!https && !process.argv.includes('--allow-http')) {
    process.stderr.write(
      'The site must be https (use --allow-http only for a local rehearsal)\n',
    );
    return 2;
  }
  const origin = site.origin;
  const at = (path: string) => `${origin}${path}`;
  const findings: Finding[] = [];
  const unreachable = (check: string) =>
    findings.push({ check, level: 'fail', detail: 'no answer' });

  // 1. plain http is redirected to https
  if (https) {
    const plain = await get(`http://${site.host}/`);
    if (!plain) unreachable('http:// redirects to https://');
    else
      findings.push(
        [301, 308].includes(plain.status) &&
          (plain.headers.get('location') ?? '').startsWith('https://')
          ? { check: 'http:// redirects to https://', level: 'pass' }
          : {
              check: 'http:// redirects to https://',
              level: 'fail',
              detail: `answered ${plain.status}`,
            },
      );
  }

  // 2. pages: security headers and CSP
  const home = await get(at('/'));
  if (!home) unreachable('home page');
  else {
    findings.push(
      home.status === 200
        ? { check: 'home page answers 200', level: 'pass' }
        : {
            check: 'home page answers 200',
            level: 'fail',
            detail: `got ${home.status}`,
          },
    );
    findings.push(
      ...pageHeaderFindings(home.headers, {
        https,
        where: '/',
        production: process.argv.includes('--production'),
      }),
    );
  }
  const login = await get(at('/auth/login'));
  if (!login) unreachable('/auth/login');
  else {
    findings.push(
      login.headers.get('referrer-policy') === 'no-referrer'
        ? { check: '/auth/login: Referrer-Policy no-referrer', level: 'pass' }
        : {
            check: '/auth/login: Referrer-Policy no-referrer',
            level: 'fail',
            detail: 'token links could leak through the Referer header',
          },
    );
  }
  for (const path of ['/auth/login', '/account', '/checkout', '/admin']) {
    const r = path === '/auth/login' ? login : await get(at(path));
    if (!r) continue;
    findings.push(
      /noindex/i.test(r.headers.get('x-robots-tag') ?? '')
        ? { check: `${path}: X-Robots-Tag noindex`, level: 'pass' }
        : {
            check: `${path}: X-Robots-Tag noindex`,
            level: 'fail',
            detail: 'a private page may be indexed',
          },
    );
  }

  // 3. robots and sitemap
  const robots = await get(at('/robots.txt'));
  if (!robots || robots.status !== 200) unreachable('robots.txt');
  else findings.push(...robotsFindings(robots.body));
  const sitemap = await get(at('/sitemap.xml'));
  if (!sitemap || sitemap.status !== 200) unreachable('sitemap.xml');
  else findings.push(...sitemapFindings(sitemap.body, origin));

  // 4. API through the same address (CloudFront -> ALB /api/v1/*)
  const categories = await get(at('/api/v1/catalog/categories'));
  if (!categories) unreachable('GET /api/v1/catalog/categories');
  else {
    findings.push(
      ...envelopeFindings(categories.body, 'GET /api/v1/catalog/categories'),
      ...cacheFindings(categories.headers, {
        where: 'GET /api/v1/catalog/categories',
        cacheable: true,
      }),
      ...commonFindings(categories.headers, { https, where: 'API' }),
    );
  }
  const me = await get(at('/api/v1/me'));
  if (!me) unreachable('GET /api/v1/me');
  else {
    findings.push(
      ...errorBodyFindings(me.status, me.body, {
        where: 'GET /api/v1/me (signed out)',
        expectStatus: 401,
      }),
      ...cacheFindings(me.headers, {
        where: 'GET /api/v1/me',
        cacheable: false,
      }),
    );
  }
  const missing = await get(at('/api/v1/verify-site-no-such-route'));
  if (!missing) unreachable('unknown API route');
  else
    findings.push(
      ...errorBodyFindings(missing.status, missing.body, {
        where: 'unknown API route',
        expectStatus: 404,
      }),
    );
  // malformed JSON is refused by the body parser, before any guard or limiter: nothing is created
  const malformed = await get(at('/api/v1/contact'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":',
  });
  if (!malformed) unreachable('malformed JSON');
  else
    findings.push(
      ...errorBodyFindings(malformed.status, malformed.body, {
        where: 'malformed JSON',
        expectStatus: 400,
      }),
    );

  // 5. CORS: a foreign origin is not allowed to call the API with credentials
  const preflight = await get(at('/api/v1/auth/login'), {
    method: 'OPTIONS',
    headers: {
      origin: FOREIGN_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  if (!preflight) unreachable('CORS preflight');
  else
    findings.push(
      ...corsFindings(preflight.headers, FOREIGN_ORIGIN, 'CORS preflight'),
    );

  // 6. no leftover files (fetch normalises "..", so path traversal cannot be probed from here)
  for (const path of ['/.env', '/.git/config']) {
    const r = await get(at(path));
    if (!r) continue;
    findings.push(
      r.status === 200
        ? {
            check: `${path} is not served`,
            level: 'fail',
            detail: 'answered 200',
          }
        : { check: `${path} is not served`, level: 'pass' },
    );
  }

  for (const f of findings) {
    const tag =
      f.level === 'pass' ? 'PASS' : f.level === 'warn' ? 'WARN' : 'FAIL';
    process.stdout.write(
      `${tag}  ${f.check}${f.detail ? `: ${f.detail}` : ''}\n`,
    );
  }
  const { failed, warned } = summarise(findings);
  process.stdout.write(
    `\n${findings.length} checks, ${failed} failed, ${warned} warning(s).\n`,
  );
  return failed ? 1 : 0;
}

process.exitCode = await main();
