import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CatalogLoading } from '@/components/CatalogLoading';
import { CatalogPage } from '@/components/CatalogPage';
import { parseProductQuery } from '@/lib/catalog-api';
import { canonicalFor, isFilteredListing } from '@/lib/site';

type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  return {
    title: 'On sale | Yalli',
    description: 'Products at a special price right now at Yalli.',
    ...canonicalFor('/specials'),
    ...(isFilteredListing(await searchParams) ? { robots: { index: false, follow: true } } : {}),
  };
}

/** Everything currently on sale: the catalogue with the server's `special` filter (a live sale price, inside its dates). */
export default async function SpecialsPage({ searchParams }: { searchParams: Search }) {
  const query = { ...parseProductQuery(await searchParams), special: true };
  return (
    <Suspense fallback={<CatalogLoading />}>
      <CatalogPage query={query} heading="On sale" />
    </Suspense>
  );
}
