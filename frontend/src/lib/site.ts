import type { Metadata } from 'next';
import { BUSINESS } from './business';
import { normalizeSiteUrl } from './seo';

/**
 * The public address of the storefront (NEXT_PUBLIC_BUSINESS_WEBSITE_URL, e.g. https://yalli.in). When it is not set,
 * nothing that needs an absolute URL is emitted (no canonical links, no sitemap): a wrong host is worse than none.
 */
export const SITE_URL = normalizeSiteUrl(BUSINESS.websiteUrl);

/** `alternates.canonical` for a route, or nothing when the site address is unknown. */
export const canonicalFor = (path: string): Pick<Metadata, 'alternates'> => (SITE_URL ? { alternates: { canonical: path } } : {});

/** Listings with filters, search or paging are for people, not for the index: they would be thin duplicates. */
export function isFilteredListing(params: Record<string, string | string[] | undefined>): boolean {
  return ['q', 'brand', 'min', 'max', 'inStock', 'sale', 'sort', 'page'].some((k) => {
    const v = params[k];
    const value = Array.isArray(v) ? v[0] : v;
    return value !== undefined && value !== '' && !(k === 'page' && value === '1');
  });
}
