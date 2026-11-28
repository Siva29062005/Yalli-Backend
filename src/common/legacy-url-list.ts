/**
 * A list of OLD store addresses (one per line: absolute URLs from the old sitemap or a Search Console export, or paths),
 * turned into the path+query to request from the new site. Pure (unit-tested); `npm run verify:redirects` uses it.
 * Blank lines and `#` comments are skipped; anything that is not an http(s) URL or a path is reported, never fetched
 * elsewhere (only the new site's origin is ever requested).
 */
export interface ParsedList {
  paths: string[];
  rejected: number;
}

export function parseOldUrls(text: string, max = 5000): ParsedList {
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let path: string | null = null;
    if (line.startsWith('//')) {
      rejected += 1; // protocol-relative: a host, not a path
      continue;
    }
    try {
      const u = line.startsWith('/')
        ? new URL(line, 'https://old.invalid')
        : new URL(line);
      if (u.protocol === 'http:' || u.protocol === 'https:')
        path = `${u.pathname}${u.search}`;
    } catch {
      path = null;
    }
    if (!path) {
      rejected += 1;
      continue;
    }
    seen.add(path);
    if (seen.size >= max) break;
  }
  return { paths: [...seen], rejected };
}
