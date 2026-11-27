import { Suspense } from 'react';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CatalogView } from '@/components/CatalogView';
import { listBrands, listProducts, type ProductQuery } from '@/lib/catalog-api';

/** Server-rendered catalogue: filtering, sorting and pagination happen in the API, driven by the URL. */
export async function CatalogPage({
  query,
  categorySlug,
  heading,
  hideBrandFilter = false,
}: {
  query: ProductQuery;
  categorySlug?: string;
  /** Overrides the listing heading (brand and specials pages). */
  heading?: string;
  /** A brand page already IS one brand. */
  hideBrandFilter?: boolean;
}) {
  const [products, brands] = await Promise.allSettled([
    listProducts(query),
    hideBrandFilter ? Promise.resolve([]) : listBrands(query.category),
  ]);
  const error =
    products.status === 'rejected'
      ? products.reason instanceof Error
        ? products.reason.message
        : 'Please try again shortly.'
      : null;

  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-8 lg:px-12">
        <Suspense>
          <CatalogView
            page={products.status === 'fulfilled' ? products.value : null}
            error={error}
            brands={brands.status === 'fulfilled' ? brands.value.filter((b) => b.productCount > 0) : []}
            query={query}
            categorySlug={categorySlug}
            heading={heading}
          />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
