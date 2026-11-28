/**
 * Old OpenCart addresses -> pages of this shop, so search rankings and bookmarks survive the cut-over (Phase 15).
 * Pure (unit-tested); `src/proxy.ts` answers a match with a 301 BEFORE routing, and everything else goes on to the
 * normal pages and 404 (so unknown addresses stay cheap prerendered 404s).
 *
 * Data, both committed:
 *  - `src/data/legacy-redirects.json` = `migration/redirects.json` from `npm run convert:opencart`, copied as it is;
 *  - `src/data/legacy-redirects-extra.json` = entries written by hand (information pages, anything the converter does
 *    not know); they win, and copying a new converter file never overwrites them.
 * Every destination must be a known page of this shop (`isSafeTarget`): anything else is dropped, so a bad or tampered
 * file can neither cause an open redirect nor send visitors in a loop.
 *
 * Because the proxy runs before routing, an address whose first segment is a page of this shop (`RESERVED_SEGMENTS`)
 * is never redirected: a new page always wins over an old keyword.
 */
export interface LegacyEntry {
  kind: 'product' | 'category' | 'brand' | 'information';
  id: string;
  keyword: string | null;
  to: string;
}

export interface LegacyMap {
  product: Map<string, string>;
  category: Map<string, string>;
  brand: Map<string, string>;
  information: Map<string, string>;
  keyword: Map<string, string>;
  /** Entries left out (bad shape or a destination that is not a known page). */
  dropped: number;
}

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** Fixed pages a legacy address may lead to. */
const PAGES = new Set([
  '/',
  '/catalog',
  '/brands',
  '/specials',
  '/compare',
  '/cart',
  '/help',
  '/shipping',
  '/returns',
  '/privacy',
  '/terms',
  '/contact',
  '/auth/login',
  '/auth/register',
]);
const ITEM = new RegExp(`^/(?:products|catalog|brands)/${SLUG}$`);
/** A product, category or brand page, or one of the fixed pages: never a host, query, `..` or unknown path. */
export const isSafeTarget = (to: unknown): to is string =>
  typeof to === 'string' && to.length <= 200 && (PAGES.has(to) || ITEM.test(to));

/**
 * First path segments that belong to this shop (its pages, the API proxy, Next's files): never treated as an old
 * keyword. Keep in step with `src/app` (a unit test compares them).
 */
export const RESERVED_SEGMENTS = new Set([
  'account',
  'admin',
  'auth',
  'brands',
  'cart',
  'catalog',
  'checkout',
  'compare',
  'contact',
  'help',
  'orders',
  'privacy',
  'products',
  'returns',
  'shipping',
  'specials',
  'terms',
  'robots.txt',
  'sitemap.xml',
  'favicon.ico',
  'api',
  'media',
  'health',
  '_next',
  '.well-known',
  // the short email paths redirected in next.config.ts
  'login',
  'register',
  'verify-email',
  'reset-password',
]);

const ID = /^[0-9]{1,10}(?:_[0-9]{1,10}){0,10}$/;
/** OpenCart casts ids to numbers: "042" is product 42, "020_027" is category path 20_27. */
const normId = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  if (!ID.test(s)) return null;
  return s
    .split('_')
    .map((p) => String(Number(p)))
    .join('_');
};
const KINDS = new Set(['product', 'category', 'brand', 'information']);

/**
 * OpenCart's default information pages (sample data ids and keywords). The live store's may differ: add entries to
 * `legacy-redirects-extra.json` (they take precedence; docs/ops/go-live.md).
 */
const DEFAULT_INFORMATION: LegacyEntry[] = [
  { kind: 'information', id: '3', keyword: 'privacy', to: '/privacy' },
  { kind: 'information', id: '4', keyword: 'about_us', to: '/contact' },
  { kind: 'information', id: '5', keyword: 'terms', to: '/terms' },
  { kind: 'information', id: '6', keyword: 'delivery', to: '/shipping' },
];

const normKeyword = (k: string) => k.trim().toLowerCase().replace(/\.html?$/, '');

export function buildLegacyMap(...sources: unknown[]): LegacyMap {
  const map: LegacyMap = {
    product: new Map(),
    category: new Map(),
    brand: new Map(),
    information: new Map(),
    keyword: new Map(),
    dropped: 0,
  };
  const entries = sources.flatMap((s) => (Array.isArray(s) ? (s as unknown[]) : []));
  for (const e of [...DEFAULT_INFORMATION, ...entries]) {
    const x = e as Partial<LegacyEntry> | null;
    const id = x && typeof x.id === 'string' ? normId(x.id) : null;
    if (
      !x ||
      typeof x !== 'object' ||
      !KINDS.has(String(x.kind)) ||
      !id ||
      !isSafeTarget(x.to) ||
      (x.keyword !== null && x.keyword !== undefined && (typeof x.keyword !== 'string' || x.keyword.length > 255))
    ) {
      map.dropped += 1;
      continue;
    }
    const byKind = map[x.kind as LegacyEntry['kind']];
    byKind.set(id, x.to);
    // categories: also by their own id (the last part of "20_27"), as OpenCart links use either
    if (x.kind === 'category') {
      const last = id.split('_').pop()!;
      if (!byKind.has(last) || last === id) byKind.set(last, x.to);
    }
    if (x.keyword) {
      const k = normKeyword(x.keyword);
      map.keyword.set(k, x.to);
      // OpenCart 4 category keywords can hold a path ("desktops/mac"): also by the last part
      const lastPart = k.split('/').pop()!;
      if (lastPart !== k && !map.keyword.has(lastPart)) map.keyword.set(lastPart, x.to);
    }
  }
  return map;
}

/** A query string as PHP reads it: `&amp;` mistakes repaired (`amp;product_id` -> `product_id`), the last value wins. */
export type LegacyQuery = Map<string, string>;
export function normalizeQuery(pairs: Iterable<[string, string]>): LegacyQuery {
  const q: LegacyQuery = new Map();
  for (const [k, v] of pairs) q.set(k.replace(/^(?:amp;)+/i, ''), v);
  return q;
}

/** Fixed OpenCart routes that need no data (`.`/`|` already normalised to `.`). A Map: no prototype keys. */
const STATIC_ROUTES = new Map<string, string>([
  ['common/home', '/'],
  ['product/special', '/specials'],
  ['product/manufacturer', '/brands'],
  ['product/compare', '/compare'],
  ['information/contact', '/contact'],
  ['information/sitemap', '/'],
  ['extension/feed/google_sitemap', '/sitemap.xml'],
  ['account/login', '/auth/login'],
  ['account/register', '/auth/register'],
  ['account/forgotten', '/auth/reset-password'],
  ['account/account', '/account/profile'],
  ['account/edit', '/account/profile'],
  ['account/password', '/account/security'],
  ['account/address', '/account/addresses'],
  ['account/order', '/account/orders'],
  ['account/order.info', '/account/orders'],
  ['account/order/info', '/account/orders'],
  ['account/wishlist', '/account/wishlist'],
  ['account/return', '/account/returns'],
  ['checkout/cart', '/cart'],
  ['checkout/checkout', '/cart'],
]);

function fromRoute(query: LegacyQuery, map: LegacyMap): string | null {
  const route = (query.get('route') ?? 'common/home').trim().toLowerCase().replace(/\|/g, '.');
  switch (route) {
    case 'product/product': {
      const p = normId(query.get('product_id'));
      return p ? (map.product.get(p) ?? null) : null;
    }
    case 'product/category': {
      if (!query.has('path')) return '/catalog';
      const path = normId(query.get('path'));
      if (!path) return null;
      return map.category.get(path) ?? map.category.get(path.split('_').pop()!) ?? null;
    }
    case 'product/manufacturer.info':
    case 'product/manufacturer/info': {
      const m = normId(query.get('manufacturer_id'));
      return m ? (map.brand.get(m) ?? null) : null;
    }
    case 'information/information': {
      const i = normId(query.get('information_id'));
      return i ? (map.information.get(i) ?? null) : null;
    }
    case 'product/search': {
      // whole characters only (cutting an emoji in half would make encodeURIComponent throw)
      const q = Array.from((query.get('search') ?? query.get('tag') ?? '').trim())
        .slice(0, 100)
        .join('');
      return q ? `/catalog?q=${encodeURIComponent(q)}` : '/catalog';
    }
    default:
      return STATIC_ROUTES.get(route) ?? null;
  }
}

function fromKeywordPath(parts: readonly string[], map: LegacyMap, requested: string): string | null {
  if (parts.length === 0 || parts.length > 8) return null;
  const full = normKeyword(parts.join('/'));
  const last = normKeyword(parts.at(-1)!);
  const to = map.keyword.get(full) ?? map.keyword.get(last) ?? null;
  // never send a path to itself
  return to && to !== requested ? to : null;
}

/**
 * Where an old address now lives, or null (let the request through: a page of this shop, or the normal 404).
 * `pathname` is the raw (percent-encoded) path; `query` its normalised query string.
 */
export function legacyRedirect(pathname: string, query: LegacyQuery, map: LegacyMap): string | null {
  let parts: string[];
  try {
    parts = pathname
      .split('/')
      .map((s) => decodeURIComponent(s).trim())
      .filter(Boolean);
  } catch {
    return null; // malformed percent-encoding: not an old link, the normal 404 answers
  }
  const requested = `/${parts.join('/').toLowerCase()}`;
  const first = parts[0]?.toLowerCase();

  // /index.php?route=… and /index.php?_route_=keyword (OpenCart 3's rewrite target)
  if (parts.length === 1 && first === 'index.php') {
    const rewritten = query.get('_route_');
    if (rewritten) return fromKeywordPath(rewritten.split('/').filter(Boolean), map, requested);
    return fromRoute(query, map);
  }
  // the home page with an OpenCart route (/?route=…); otherwise it is the home page
  if (parts.length === 0) return query.has('route') ? fromRoute(query, map) : null;
  // a page of this shop, or a file (images, scripts): never an old keyword
  if (RESERVED_SEGMENTS.has(first!)) return null;
  if (/\.(?!html?$)[a-z0-9]{1,5}$/i.test(parts.at(-1)!)) return null;
  // OpenCart 4 also accepts ?route= on its language path (/en-gb?route=product/product&product_id=42)
  if (query.has('route')) {
    const viaRoute = fromRoute(query, map);
    if (viaRoute) return viaRoute;
  }
  return fromKeywordPath(parts, map, requested);
}
