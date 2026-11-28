import { readFileSync } from 'node:fs';
import { isHomeAddress, parseOldUrls } from '../common/legacy-url-list.js';

/**
 * Go-live check (Phase 15): every OLD store address in a list must reach a page of the new site that answers 200,
 * through permanent redirects only (301/308, at most 5), or already be a page (200: the home page, /privacy …).
 * Landing on the home page from anything but an old home address fails (a lost query string sends every old product
 * link there). Read-only GETs, only to --site (and --main): the host written in the list is never requested.
 *
 *   node dist/cli/verify-redirects.js --site https://yalli.in --urls migration/old-urls.txt
 *   node dist/cli/verify-redirects.js --site https://www.yalli.in --main https://yalli.in --urls migration/old-urls.txt
 *
 * --main: the main hostname, when --site is the OTHER one: every address must then be redirected to --main (keeping
 * its path and query). --concurrency (default 2, at most 8) and --delay-ms between requests (default 250) keep the run
 * gentle on the live site and its shared limits; the list: the old sitemap, a Search Console export, plain URLs.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = { 'user-agent': 'yalli-verify-redirects' };

async function hop(url: URL): Promise<{ status: number; location: string }> {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: UA,
  });
  await res.body?.cancel(); // never keep a connection busy with a body nobody reads
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

async function check(
  site: string,
  main: string | null,
  path: string,
  delayMs: number,
): Promise<{ problem: string | null; direct: boolean }> {
  const allowed = new Set([site, ...(main ? [main] : [])]);
  let url = new URL(`${site}${path}`);
  for (let n = 0; n <= 5; n++) {
    const { status, location } = await hop(url);
    if (status === 200) {
      if (n === 0 && main)
        return {
          problem:
            'answers 200 on this hostname instead of a 301 to the main one',
          direct: false,
        };
      if (main && url.origin !== main)
        return {
          problem: `ends on ${url.origin}, not the main hostname`,
          direct: false,
        };
      if (n > 0 && url.pathname === '/' && !isHomeAddress(path))
        return {
          problem:
            'lands on the home page (a lost query string, or a missing map entry?)',
          direct: false,
        };
      return { problem: null, direct: n === 0 };
    }
    if (![301, 308].includes(status))
      return {
        problem:
          n === 0
            ? `answered ${status}`
            : `${url.pathname}${url.search} answered ${status}`,
        direct: false,
      };
    const next = new URL(location, url);
    if (!allowed.has(next.origin))
      return {
        problem: `redirects off the site (${next.origin})`,
        direct: false,
      };
    url = next;
    if (delayMs) await sleep(delayMs);
  }
  return { problem: 'more than 5 redirects', direct: false };
}

async function main(): Promise<number> {
  const siteArg = arg('site');
  const file = arg('urls');
  const concurrency = Number(arg('concurrency') ?? 2);
  const delayMs = Number(arg('delay-ms') ?? 250);
  if (
    !siteArg ||
    !file ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isInteger(delayMs) ||
    delayMs < 0
  ) {
    process.stderr.write(
      'Usage: node dist/cli/verify-redirects.js --site <https://site> --urls <file> [--main <https://main>] [--concurrency 1-8] [--delay-ms N]\n',
    );
    return 2;
  }
  let site: string;
  let mainOrigin: string | null = null;
  try {
    site = new URL(siteArg).origin;
    if (arg('main')) mainOrigin = new URL(arg('main')!).origin;
  } catch {
    process.stderr.write('--site and --main must be URLs\n');
    return 2;
  }
  const { paths, rejected, capped } = parseOldUrls(readFileSync(file, 'utf8'));
  for (const line of rejected.slice(0, 10))
    process.stdout.write(`NOT AN ADDRESS  ${line}\n`);
  if (paths.length === 0) {
    process.stdout.write('The list holds no addresses: nothing was checked.\n');
    return 1;
  }
  let failed = 0;
  let direct = 0;
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      let result: { problem: string | null; direct: boolean };
      try {
        result = await check(site, mainOrigin, path, delayMs);
      } catch (err) {
        result = {
          problem: `no answer (${(err as Error).name})`,
          direct: false,
        };
      }
      if (result.direct) direct += 1;
      if (result.problem) {
        failed += 1;
        process.stdout.write(`FAIL  ${path}: ${result.problem}\n`);
      }
      if (delayMs) await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(
    `\n${paths.length} old addresses checked: ${paths.length - failed} reach a page (${direct} are pages already), ${failed} failed` +
      `${rejected.length ? `; ${rejected.length} lines were not addresses` : ''}` +
      `${capped ? '; the list was longer than 5000 addresses and was cut' : ''}.\n`,
  );
  return failed || rejected.length || capped ? 1 : 0;
}

process.exitCode = await main();
