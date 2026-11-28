/**
 * Old OpenCart addresses -> pages of this shop, so search rankings and bookmarks survive the cut-over (Phase 15).
 * Pure (unit-tested); `app/[...legacy]/page.tsx` answers with a permanent redirect (308, which search engines treat like
 * 301) or the normal 404.
 *
 * Data: `src/data/legacy-redirects.json` is `migration/redirects.json` from `npm run convert:opencart`, copied as it is
 * (docs/ops/go-live.md). Every destination must be a plain path on this site: anything else is dropped, so a bad or
 * tampered file can never turn this into an open redirect.
 *
 * Handled: `index.php?route=…` (OpenCart 3 and 4, `.` or `|` before the method, ids such as `path=20_27`) and SEO
 * keyword paths (`/keyword`, `/category/sub/product-keyword`, OpenCart 4 `/en-gb/product/keyword`, an optional `.html`).
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
  /** Entries left out (bad shape or a destination that is not a plain path on this site). */
  dropped: number;
}

/** A plain path on this site: lower-case slug segments only (no host, query, `..`, `//` or backslash). */
const SAFE_PATH = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/;
export const isSafeTarget = (to: unknown): to is string => typeof to === 'string' && to.length <= 200 && SAFE_PATH.test(to);

const ID = /^[0-9]{1,10}(?:_[0-9]{1,10}){0,10}$/;
const KINDS = new Set(['product', 'category', 'brand', 'information']);

/**
 * OpenCart's default information pages (sample data ids and keywords). The live store's may differ: the file can carry
 * `information` entries, which take precedence (check them against the live site, docs/ops/go-live.md).
 */
const DEFAULT_INFORMATION: LegacyEntry[] = [
  { kind: 'information', id: '3', keyword: 'privacy', to: '/privacy' },
  { kind: 'information', id: '4', keyword: 'about_us', to: '/contact' },
  { kind: 'information', id: '5', keyword: 'terms', to: '/terms' },
  { kind: 'information', id: '6', keyword: 'delivery', to: '/shipping' },
];

const normKeyword = (k: string) => k.trim().toLowerCase().replace(/\.html?$/, '');

export function buildLegacyMap(raw: unknown): LegacyMap {
  const map: LegacyMap = {
    product: new Map(),
    category: new Map(),
    brand: new Map(),
    information: new Map(),
    keyword: new Map(),
    dropped: 0,
  };
  const entries = Array.isArray(raw) ? raw : [];
  for (const e of [...DEFAULT_INFORMATION, ...entries] as unknown[]) {
    const x = e as Partial<LegacyEntry> | null;
    if (
      !x ||
      typeof x !== 'object' ||
      !KINDS.has(String(x.kind)) ||
      typeof x.id !== 'string' ||
      !ID.test(x.id) ||
      !isSafeTarget(x.to) ||
      (x.keyword !== null && x.keyword !== undefined && (typeof x.keyword !== 'string' || x.keyword.length > 255))
    ) {
      map.dropped += 1;
      continue;
    }
    const byKind = map[x.kind as LegacyEntry['kind']];
    byKind.set(x.id, x.to);
    // categories: also by their own id (the last part of "20_27"), as OpenCart links use either
    if (x.kind === 'category') {
      const last = x.id.split('_').pop()!;
      if (!byKind.has(last) || last === x.id) byKind.set(last, x.to);
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

type Query = { get(name: string): string | null };

/** Fixed OpenCart routes that need no data (`.`/`|` already normalised to `.`). */
const STATIC_ROUTES: Record<string, string> = {
  'common/home': '/',
  'product/special': '/specials',
  'product/manufacturer': '/brands',
  'product/compare': '/compare',
  'information/contact': '/contact',
  'information/sitemap': '/',
  'account/login': '/auth/login',
  'account/register': '/auth/register',
  'account/forgotten': '/auth/reset-password',
  'account/account': '/account/profile',
  'account/edit': '/account/profile',
  'account/password': '/account/security',
  'account/address': '/account/addresses',
  'account/order': '/account/orders',
  'account/wishlist': '/account/wishlist',
  'account/return': '/account/returns',
  'checkout/cart': '/cart',
  'checkout/checkout': '/cart',
};

function fromRoute(query: Query, map: LegacyMap): string | null {
  const route = (query.get('route') ?? 'common/home').trim().toLowerCase().replace(/\|/g, '.');
  const id = (name: string) => {
    const v = query.get(name)?.trim() ?? '';
    return ID.test(v) ? v : null;
  };
  switch (route) {
    case 'product/product': {
      const p = id('product_id');
      return p ? (map.product.get(p) ?? null) : null;
    }
    case 'product/category': {
      const path = id('path');
      if (!path) return '/catalog';
      return map.category.get(path) ?? map.category.get(path.split('_').pop()!) ?? null;
    }
    case 'product/manufacturer.info':
    case 'product/manufacturer/info': {
      const m = id('manufacturer_id');
      return m ? (map.brand.get(m) ?? null) : null;
    }
    case 'information/information': {
      const i = id('information_id');
      return i ? (map.information.get(i) ?? null) : null;
    }
    case 'product/search': {
      const q = (query.get('search') ?? query.get('tag') ?? '').trim().slice(0, 100);
      return q ? `/catalog?q=${encodeURIComponent(q)}` : '/catalog';
    }
    default:
      return STATIC_ROUTES[route] ?? null;
  }
}

/**
 * Where an old address now lives, or null (404). `segments` are the decoded path segments of a request no page of this
 * shop matched; `query` its query string.
 */
export function resolveLegacy(segments: readonly string[], query: Query, map: LegacyMap): string | null {
  const parts = segments.map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0]!.toLowerCase() === 'index.php') return fromRoute(query, map);
  if (parts.length === 0 || parts.length > 8) return null;
  // OpenCart 4 also accepts ?route= on its language path (/en-gb?route=product/product&product_id=42)
  if (query.get('route')) {
    const viaRoute = fromRoute(query, map);
    if (viaRoute) return viaRoute;
  }
  const full = normKeyword(parts.join('/'));
  const last = normKeyword(parts.at(-1)!);
  const to = map.keyword.get(full) ?? map.keyword.get(last) ?? null;
  // never send a path to itself (a destination no page serves would otherwise redirect forever)
  return to && to !== `/${parts.join('/').toLowerCase()}` ? to : null;
}
