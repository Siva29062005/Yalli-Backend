import { notFound } from 'next/navigation';
import { CatalogPage } from '@/components/CatalogPage';
import { parseProductQuery } from '@/lib/catalog-api';

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
