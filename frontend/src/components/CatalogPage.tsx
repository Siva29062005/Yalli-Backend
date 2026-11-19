import { Suspense } from 'react';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';
import { CatalogView } from '@/components/CatalogView';
import { listBrands, listProducts, type ProductQuery } from '@/lib/catalog-api';

/** Server-rendered catalogue: filtering, sorting and pagination happen in the API, driven by the URL. */
export async function CatalogPage({ query, categorySlug }: { query: ProductQuery; categorySlug?: string }) {
  const [products, brands] = await Promise.allSettled([listProducts(query), listBrands()]);
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
      <CartDrawer />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-8 lg:px-12">
        <Suspense>
          <CatalogView
            page={products.status === 'fulfilled' ? products.value : null}
            error={error}
            brands={brands.status === 'fulfilled' ? brands.value.filter((b) => b.productCount > 0) : []}
            query={query}
            categorySlug={categorySlug}
          />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
