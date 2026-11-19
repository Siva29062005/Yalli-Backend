import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';
import { ProductDetailClient } from '@/components/ProductDetailClient';
import { getProduct, getReviews, listProducts } from '@/lib/catalog-api';

const load = cache(getProduct);

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const product = await load((await params).slug).catch(() => null);
  if (!product) return { title: 'Product not found | Yalli' };
  const image = product.images.find((i) => i.url)?.url;
  return {
    title: `${product.name} | Yalli`,
    description: product.summary ?? undefined,
    openGraph: { title: product.name, images: image ? [image] : undefined },
  };
}

export default async function ProductPage({ params }: Params) {
  const { slug } = await params;
  const product = await load(slug);
  if (!product) notFound();

  const categorySlug = product.categories[0]?.slug;
  // Reviews and related items are secondary: their failure must not take down the product page.
  const [reviews, related] = await Promise.allSettled([
    getReviews(slug),
    categorySlug ? listProducts({ category: categorySlug, pageSize: 5, inStock: true }) : null,
  ]);

  return (
    <>
      <AnnouncementBar />
      <Header />
      <CartDrawer />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-8 lg:px-12">
        <ProductDetailClient
          product={product}
          reviews={reviews.status === 'fulfilled' ? reviews.value : null}
          relatedProducts={
            related.status === 'fulfilled' && related.value
              ? related.value.items.filter((p) => p.id !== product.id).slice(0, 4)
              : []
          }
        />
      </main>
      <Footer />
    </>
  );
}
