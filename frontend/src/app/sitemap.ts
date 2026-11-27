import type { MetadataRoute } from 'next';
import { listAllProductSlugs, listBrands, listCategoryTree } from '@/lib/catalog-api';
import { flattenCategories } from '@/lib/category-utils';
import { sitemapEntries } from '@/lib/seo';
import { SITE_URL } from '@/lib/site';

// Built when a crawler asks, not at build time: the build machine usually cannot reach the API, and a sitemap frozen
// without products would stay wrong. The API calls below are cached for a few minutes.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!SITE_URL) return [];
  // Categories and products are best-effort: an API outage must still yield the static pages, never a 500.
  const [categories, products, brands] = await Promise.all([
    listCategoryTree().then((tree) => flattenCategories(tree).map((c) => c.slug)).catch(() => []),
    listAllProductSlugs().catch(() => []),
    listBrands().then((list) => list.filter((b) => b.productCount > 0).map((b) => b.slug)).catch(() => []),
  ]);
  return sitemapEntries({ siteUrl: SITE_URL, categorySlugs: categories, productSlugs: products, brandSlugs: brands });
}
