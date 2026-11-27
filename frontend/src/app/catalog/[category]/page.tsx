import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CatalogPage } from '@/components/CatalogPage';
import { listCategoryTree, parseProductQuery } from '@/lib/catalog-api';
import { flattenCategories } from '@/lib/category-utils';
import { canonicalFor, isFilteredListing } from '@/lib/site';

type Params = { params: Promise<{ category: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { category } = await params;
  // The name is best-effort: if the API is down the page still gets a sensible title.
  const name = await listCategoryTree()
    .then((tree) => flattenCategories(tree).find((c) => c.slug === category)?.name)
    .catch(() => undefined);
  return {
    title: `${name ?? 'Shop'} | Yalli`,
    description: name ? `Shop ${name} at Yalli: thoughtfully chosen, honestly priced, delivered across India.` : undefined,
    ...canonicalFor(`/catalog/${category}`),
    ...(isFilteredListing(await searchParams) ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { category } = await params;
  const query = parseProductQuery(await searchParams, category);
  if (!query.category) notFound();
  return <CatalogPage query={query} categorySlug={category} />;
}
