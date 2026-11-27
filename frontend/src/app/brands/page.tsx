import type { Metadata } from 'next';
import Link from 'next/link';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { listBrands, type Brand } from '@/lib/catalog-api';
import { canonicalFor } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Brands | Yalli',
  description: 'Shop Yalli by brand.',
  ...canonicalFor('/brands'),
};

export default async function BrandsPage() {
  // Best-effort: an API outage shows a message instead of a broken page.
  const brands: Brand[] | null = await listBrands()
    .then((list) => list.filter((b) => b.productCount > 0))
    .catch(() => null);
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="mx-auto w-full max-w-[1200px] flex-1 space-y-6 px-4 py-8 md:px-8">
        <h1 className="font-heading text-[28px] font-bold text-[#113322] md:text-[36px]">Brands</h1>
        {brands === null ? (
          <p className="text-[14px] text-[#5F6B64]">Brands are unavailable right now. Please try again shortly.</p>
        ) : brands.length === 0 ? (
          <p className="text-[14px] text-[#5F6B64]">No brands yet. <Link href="/catalog" className="font-semibold text-[#116644] hover:underline">Browse all products</Link></p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {brands.map((b) => (
              <li key={b.slug}>
                <Link
                  href={`/brands/${b.slug}`}
                  className="flex min-w-0 flex-col rounded-2xl border border-[#E6EAE7] bg-white p-4 transition hover:border-[#116644] hover:shadow-md"
                >
                  <span className="break-words text-[15px] font-semibold text-[#113322]">{b.name}</span>
                  <span className="text-[12px] text-[#5F6B64]">{b.productCount} {b.productCount === 1 ? 'product' : 'products'}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      <Footer />
    </>
  );
}
