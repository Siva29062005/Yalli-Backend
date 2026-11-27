import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { CatalogLoading } from '@/components/CatalogLoading';
import { CatalogPage } from '@/components/CatalogPage';
import { listCategoryTree, parseProductQuery } from '@/lib/catalog-api';
import { ALL_CATEGORY, flattenCategories } from '@/lib/category-utils';
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
  // "All products" is the whole catalogue, not a category the API knows.
  if (category === ALL_CATEGORY.slug) redirect('/catalog');
  const query = parseProductQuery(await searchParams, category);
  if (!query.category) notFound();
  // An unknown category is a real 404 (not an empty, indexable page). If the API is down, render and let the page say so.
  const tree = await listCategoryTree().catch(() => null);
  if (tree && !flattenCategories(tree).some((c) => c.slug === category)) notFound();
  // The skeleton streams only after the checks above, so a 404 or redirect keeps its real HTTP status.
  return (
    <Suspense fallback={<CatalogLoading />}>
      <CatalogPage query={query} categorySlug={category} />
    </Suspense>
  );
}
