import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { CatalogLoading } from '@/components/CatalogLoading';
import { CatalogPage } from '@/components/CatalogPage';
import { listBrands, parseProductQuery } from '@/lib/catalog-api';
import { canonicalFor, isFilteredListing } from '@/lib/site';

type Params = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A brand with nothing on sale (no buyable product) is a 404, like an unknown one: no empty indexable pages.
const findBrand = (slug: string) =>
  SLUG.test(slug)
    ? listBrands().then((list) => list.find((b) => b.slug === slug && b.productCount > 0) ?? null)
    : Promise.resolve(null);

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { slug } = await params;
  const brand = await findBrand(slug).catch(() => null);
  return {
    title: `${brand?.name ?? 'Brand'} | Yalli`,
    description: brand ? `Shop ${brand.name} at Yalli.` : undefined,
    ...canonicalFor(`/brands/${slug}`),
    ...(isFilteredListing(await searchParams) ? { robots: { index: false, follow: true } } : {}),
  };
}

/** One brand's products. An unknown brand is a real 404 (checked before streaming starts; see CatalogLoading). */
export default async function BrandPage({ params, searchParams }: Params) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const brand = await findBrand(slug).catch(() => undefined); // undefined = API down: render and let the page say so
  if (brand === null) notFound();
  const query = { ...parseProductQuery(await searchParams), brand: slug };
  return (
    <Suspense fallback={<CatalogLoading />}>
      <CatalogPage query={query} heading={brand?.name ?? 'Brand'} hideBrandFilter locked={{ brand: slug }} />
    </Suspense>
  );
}
