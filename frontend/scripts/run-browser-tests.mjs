// One command for the frontend browser regressions (opt-in, not part of `npm run check`):
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:browser            (from the repo root)
//   ... npm run test:browser -- --only cart,seo      run some scripts      --skip-build   reuse the last test build
// It starts the catalogue mock API, builds the storefront into its own folder (.next-browser-tests, so the normal .next
// build is untouched) with the mock API and an example site address, starts it on free ports, runs every
// scripts/test-*.mjs that uses fakes, prints a summary and stops everything. test-admin-real.mjs is not included: it
// needs the real backend (`npm run serve:browser`, see CLAUDE.md).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRONTEND = join(import.meta.dirname, '..');
const SCRIPTS = [
  'account', 'admin-access', 'admin-screens', 'auth', 'cart', 'catalog', 'categories', 'checkout', 'compare-reviews',
  'seo', 'static-pages', 'a11y',
];
const SITE_URL = 'https://shop.example.test';
const DIST = '.next-browser-tests';

const args = process.argv.slice(2);
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()) : SCRIPTS;
const unknown = only.filter((s) => !SCRIPTS.includes(s));
if (unknown.length) fail(`Unknown script(s): ${unknown.join(', ')}. Choose from: ${SCRIPTS.join(', ')}`);
const skipBuild = args.includes('--skip-build');

function fail(message) {
  console.error(`test:browser: ${message}`);
  process.exit(2);
}

// Playwright is not a dependency of this project: point PLAYWRIGHT_MODULE at an installation, or install it here.
let playwright = process.env.PLAYWRIGHT_MODULE;
if (!playwright) {
  try {
    playwright = import.meta.resolve('playwright', `file://${FRONTEND}/`);
  } catch {
    fail('Playwright not found. Set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs (or `npm i -D playwright` in frontend/).');
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const children = [];
function start(label, cmd, cmdArgs, env, { quiet = true } = {}) {
  const child = spawn(cmd, cmdArgs, {
    cwd: FRONTEND,
    env: { ...process.env, ...env },
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: true, // own process group, so stop() also ends next-server's children
  });
  let log = '';
  if (quiet) for (const s of [child.stdout, child.stderr]) s.on('data', (d) => (log = (log + d).slice(-4000)));
  child.tail = () => log;
  child.label = label;
  children.push(child);
  return child;
}
function stop() {
  for (const c of children) if (c.exitCode === null) try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ }
}
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('exit', stop);

const run = (cmd, cmdArgs, env) =>
  new Promise((resolve) => {
    const c = spawn(cmd, cmdArgs, { cwd: FRONTEND, env: { ...process.env, ...env }, stdio: 'inherit' });
    c.on('exit', (code) => resolve(code ?? 1));
  });

async function waitFor(url, child, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) fail(`${child.label} exited early:\n${child.tail()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`${child.label} did not answer at ${url} within ${timeoutMs / 1000}s:\n${child.tail()}`);
}

const [freshMockPort, webPort, deadWebPort, deadApiPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
// The build bakes the mock API address into Next's /api/v1 rewrite, so --skip-build must reuse the port it was built with.
const PORT_FILE = join(FRONTEND, DIST, 'browser-test-mock-port');
const mockPort = skipBuild && existsSync(PORT_FILE) ? Number(readFileSync(PORT_FILE, 'utf8')) : freshMockPort;
const mockApi = `http://127.0.0.1:${mockPort}/api/v1`;
// Cloudflare's public always-pass TEST site key: the captcha widget renders, and test-auth.mjs replaces Cloudflare's
// script with a local stub (no network call).
const buildEnv = {
  NEXT_DIST_DIR: DIST,
  API_INTERNAL_URL: mockApi,
  NEXT_PUBLIC_BUSINESS_WEBSITE_URL: SITE_URL,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  // the go-live notice on sign-in/sign-up (checked by test-auth.mjs)
  NEXT_PUBLIC_OLD_STORE_NOTICE: '1',
};

const mock = start('mock API', process.execPath, ['scripts/test-catalog.mjs', '--mock-api', String(mockPort)], {});
await waitFor(`${mockApi}/catalog/products`, mock);

if (!skipBuild) {
  console.log(`test:browser: building the storefront into ${DIST} (mock API ${mockApi}, site ${SITE_URL})`);
  // next build rewrites next-env.d.ts to point at its distDir; put the normal one back so editors and tsc keep using .next.
  const nextEnv = join(FRONTEND, 'next-env.d.ts');
  const savedNextEnv = existsSync(nextEnv) ? readFileSync(nextEnv, 'utf8') : null;
  const code = await run('npx', ['next', 'build', '--webpack'], buildEnv);
  if (savedNextEnv !== null) writeFileSync(nextEnv, savedNextEnv);
  if (code !== 0) fail('next build failed');
  writeFileSync(PORT_FILE, String(mockPort));
}

const web = start('frontend', 'npx', ['next', 'start', '-p', String(webPort)], buildEnv);
const frontendUrl = `http://localhost:${webPort}`;
await waitFor(frontendUrl, web);
let deadFrontendUrl;
if (only.includes('seo')) {
  // A second server whose API is unreachable: the sitemap must still answer.
  const dead = start('frontend (dead API)', 'npx', ['next', 'start', '-p', String(deadWebPort)], {
    ...buildEnv,
    API_INTERNAL_URL: `http://127.0.0.1:${deadApiPort}/api/v1`,
  });
  deadFrontendUrl = `http://localhost:${deadWebPort}`;
  await waitFor(`${deadFrontendUrl}/help`, dead);
}

const shots = mkdtempSync(join(tmpdir(), 'yalli-browser-shots-'));
mkdirSync(shots, { recursive: true });
const env = {
  FRONTEND_URL: frontendUrl,
  MOCK_API: mockApi,
  SITE_URL,
  PLAYWRIGHT_MODULE: playwright,
  SCREENSHOT_DIR: shots,
  EXPECT_CAPTCHA: '1',
  ...(deadFrontendUrl ? { DEAD_API_FRONTEND_URL: deadFrontendUrl } : {}),
};
const results = [];
for (const name of only) {
  console.log(`\n=== test-${name}.mjs`);
  const started = Date.now();
  const code = await run(process.execPath, [`scripts/test-${name}.mjs`], env);
  results.push({ name, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log('\n=== Browser regression summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  test-${r.name}.mjs  (${r.seconds}s)`);
console.log(`Screenshots: ${shots} (and /tmp/yalli-shots for scripts with a fixed folder)`);
const failed = results.filter((r) => !r.ok).length;
stop();
process.exit(failed ? 1 : 0);
