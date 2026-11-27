import type { ProductDetail, RatingSummary } from './catalog-api';

/** Pages anyone (and search engines) may see, in the order they appear in the sitemap. */
export const PUBLIC_PATHS = ['/', '/catalog', '/specials', '/brands', '/help', '/shipping', '/returns', '/privacy', '/terms', '/contact'] as const;

/** Areas that must never be indexed: account data, carts, checkout, sign-in, order pages, staff tools. */
export const PRIVATE_PATHS = ['/admin', '/account', '/cart', '/checkout', '/auth', '/orders', '/compare'] as const;

/** The public base URL as `https://host` (no trailing slash), or undefined when missing or not an http(s) URL. */
export function normalizeSiteUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

export const absoluteUrl = (siteUrl: string, path: string): string => `${siteUrl}${path === '/' ? '' : path}`;

/** 69000 -> "690.00". Integer arithmetic only: money is never a float. */
export function paiseToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError('amount must be a non-negative integer of paise');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so a product name can never close the tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const isAbsolute = (url: string | null): url is string => !!url && /^https?:\/\//i.test(url);

/**
 * schema.org Product for a product page. Only facts the shop really has are included: the current customer price (sale
 * applied), stock, and a rating only when there are approved reviews.
 */
export function productJsonLd(input: {
  product: ProductDetail;
  rating?: Pick<RatingSummary, 'count' | 'average'> | null;
  url: string | undefined;
}): Record<string, unknown> {
  const { product, rating, url } = input;
  const prices = product.variants.map((v) => v.price.amountMinor);
  const inStock = product.variants.some((v) => v.inStock);
  const availability = `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}`;
  const images = product.images.map((i) => i.url).filter(isAbsolute);

  const offers =
    prices.length === 0
      ? undefined
      : Math.min(...prices) === Math.max(...prices)
        ? { '@type': 'Offer', price: paiseToDecimal(prices[0]!), priceCurrency: 'INR', availability, ...(url ? { url } : {}) }
        : {
            '@type': 'AggregateOffer',
            lowPrice: paiseToDecimal(Math.min(...prices)),
            highPrice: paiseToDecimal(Math.max(...prices)),
            priceCurrency: 'INR',
            offerCount: prices.length,
            availability,
            ...(url ? { url } : {}),
          };

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.summary ? { description: product.summary } : {}),
    ...(images.length ? { image: images } : {}),
    ...(product.variants.length === 1 ? { sku: product.variants[0]!.sku } : {}),
    ...(product.brand ? { brand: { '@type': 'Brand', name: product.brand.name } } : {}),
    ...(offers ? { offers } : {}),
    ...(rating && rating.count > 0 && rating.average !== null
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: rating.average, reviewCount: rating.count } }
      : {}),
  };
}

/** schema.org WebSite with a site-search action that points at the catalogue search. */
export function websiteJsonLd(input: { name: string; siteUrl: string }): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: input.name,
    url: absoluteUrl(input.siteUrl, '/'),
    potentialAction: {
      '@type': 'SearchAction',
      target: `${input.siteUrl}/catalog?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

export interface SitemapEntry {
  url: string;
  changeFrequency?: 'daily' | 'weekly' | 'monthly';
  priority?: number;
}

/** The sitemap protocol allows at most 50,000 URLs per file. */
export const MAX_SITEMAP_URLS = 50_000;

export function sitemapEntries(input: {
  siteUrl: string;
  categorySlugs: readonly string[];
  productSlugs: readonly string[];
  brandSlugs?: readonly string[];
}): SitemapEntry[] {
  const { siteUrl } = input;
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  const add = (path: string, changeFrequency: SitemapEntry['changeFrequency'], priority: number) => {
    const url = absoluteUrl(siteUrl, path);
    if (seen.has(url) || out.length >= MAX_SITEMAP_URLS) return;
    seen.add(url);
    out.push({ url, changeFrequency, priority });
  };
  for (const path of PUBLIC_PATHS) add(path, path === '/' || path === '/catalog' ? 'daily' : 'monthly', path === '/' ? 1 : path === '/catalog' ? 0.9 : 0.3);
  for (const slug of input.categorySlugs) add(`/catalog/${slug}`, 'daily', 0.8);
  for (const slug of input.brandSlugs ?? []) add(`/brands/${slug}`, 'weekly', 0.6);
  for (const slug of input.productSlugs) add(`/products/${slug}`, 'weekly', 0.7);
  return out;
}
