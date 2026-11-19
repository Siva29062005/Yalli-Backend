import type { Metadata } from 'next';
import { CatalogPage } from '@/components/CatalogPage';
import { parseProductQuery } from '@/lib/catalog-api';

export const metadata: Metadata = {
  title: 'Shop all products | Yalli',
  description: 'Home, kitchen and lifestyle essentials at honest prices.',
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CatalogPage query={parseProductQuery(await searchParams)} />;
}
