import { readFileSync } from 'node:fs';
import { parseOldUrls } from '../common/legacy-url-list.js';

/**
 * Go-live check (Phase 15): every OLD store address in a list must now answer with a permanent redirect (301/308) to a
 * page of the new site that answers 200. Read-only GETs to the new site only (paths from the list are requested on
 * --site, never on the host written in the list).
 *
 *   node dist/cli/verify-redirects.js --site https://yalli.in --urls old-urls.txt
 *
 * The list: the old store's sitemap URLs (saved before cut-over) or a Search Console "top pages" export, one per line.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function check(origin: string, path: string): Promise<string | null> {
  const first = await fetch(`${origin}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'yalli-verify-redirects' },
  });
  if (![301, 308].includes(first.status))
    return `answered ${first.status}, not a permanent redirect`;
  const location = first.headers.get('location') ?? '';
  const target = new URL(location, origin);
  if (target.origin !== origin)
    return `redirects off the site (${target.origin})`;
  const page = await fetch(target, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'yalli-verify-redirects' },
  });
  await page.body?.cancel();
  return page.status === 200
    ? null
    : `redirects to ${target.pathname}, which answers ${page.status}`;
}

async function main(): Promise<number> {
  const site = arg('site');
  const file = arg('urls');
  if (!site || !file) {
    process.stderr.write(
      'Usage: node dist/cli/verify-redirects.js --site <https://site> --urls <file>\n',
    );
    return 2;
  }
  const origin = new URL(site).origin;
  const { paths, rejected } = parseOldUrls(readFileSync(file, 'utf8'));
  let failed = 0;
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      let problem: string | null;
      try {
        problem = await check(origin, path);
      } catch (err) {
        problem = `no answer (${(err as Error).name})`;
      }
      if (problem) {
        failed += 1;
        process.stdout.write(`FAIL  ${path}: ${problem}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  process.stdout.write(
    `\n${paths.length} old addresses checked, ${failed} failed${rejected ? `, ${rejected} lines were not addresses` : ''}.\n`,
  );
  return failed || rejected ? 1 : 0;
}

process.exitCode = await main();
