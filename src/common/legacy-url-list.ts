/**
 * A list of OLD store addresses turned into the path+query to request from the new site. Pure (unit-tested);
 * `npm run verify:redirects` uses it. Accepted, one address per line or mixed:
 *  - plain URLs or paths;
 *  - the old sitemap pasted as XML (`<loc>…</loc>`, `&amp;` decoded);
 *  - a Search Console export (Performance → Pages) saved as CSV: the first column, the header line skipped.
 * Only the new site's origin is ever requested (the host written in the list is ignored).
 */
export interface ParsedList {
  paths: string[];
  /** Lines that are not addresses (reported; the run fails on them). */
  rejected: string[];
  /** The list had more addresses than the cap; the rest were not checked. */
  capped: boolean;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};
const decodeXml = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (e) => ENTITIES[e]!);

function toPath(candidate: string): string | null {
  const v = decodeXml(candidate.trim().replace(/^"(.*)"$/, '$1'));
  if (v.startsWith('//')) return null; // protocol-relative: a host, not a path
  try {
    const u = v.startsWith('/')
      ? new URL(v, 'https://old.invalid')
      : new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

export function parseOldUrls(text: string, max = 5000): ParsedList {
  const seen = new Set<string>();
  const rejected: string[] = [];
  let capped = false;
  const add = (path: string) => {
    if (seen.has(path)) return;
    if (seen.size >= max) {
      capped = true;
      return;
    }
    seen.add(path);
  };
  // a pasted sitemap: every <loc>, wherever the line breaks are
  const locs = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(
    (m) => m[1]!,
  );
  if (locs.length) {
    for (const loc of locs) {
      const p = toPath(loc);
      if (p) add(p);
      else rejected.push(loc.slice(0, 100));
    }
    return { paths: [...seen], rejected, capped };
  }
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // CSV (Search Console): the address is the first column
    const cell = line.includes(',')
      ? (line.match(/^("(?:[^"]|"")*"|[^,]*)/)?.[1] ?? line)
      : line;
    const p = toPath(cell.replace(/""/g, '"'));
    const wasFirst = first;
    first = false;
    if (p) add(p);
    else if (!(wasFirst && line.includes(',')))
      rejected.push(line.slice(0, 100)); // a CSV header is skipped
  }
  return { paths: [...seen], rejected, capped };
}

/** Old addresses that ARE the home page: landing on "/" is right for them and suspicious for anything else. */
export function isHomeAddress(path: string): boolean {
  const u = new URL(path, 'https://old.invalid');
  const route = u.searchParams.get('route');
  const home = !route || route.toLowerCase() === 'common/home';
  return (
    (u.pathname === '/' || u.pathname.toLowerCase() === '/index.php') &&
    home &&
    !u.searchParams.has('_route_')
  );
}
