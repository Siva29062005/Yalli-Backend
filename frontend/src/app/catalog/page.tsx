import type { Metadata } from 'next';
import { CatalogPage } from '@/components/CatalogPage';
import { parseProductQuery } from '@/lib/catalog-api';
import { canonicalFor, isFilteredListing } from '@/lib/site';

type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  return {
    title: 'Shop all products | Yalli',
    description: 'Home, kitchen and lifestyle essentials at honest prices.',
    ...canonicalFor('/catalog'),
    // Search results, filters and later pages stay out of the index; the plain listing is the one that counts.
    ...(isFilteredListing(await searchParams) ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Search;
}) {
  return <CatalogPage query={parseProductQuery(await searchParams)} />;
}
