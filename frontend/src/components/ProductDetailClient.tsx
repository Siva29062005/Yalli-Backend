'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { requestApi } from '@/lib/http';
import { Star, Heart, ChevronDown, Minus, Plus, GitCompare } from 'lucide-react';
import { useStore } from '@/lib/store';
import { WriteReview } from '@/components/WriteReview';
import { formatPaise, calculateDiscountPercent, formatIndianDate } from '@/lib/formatters';
import {
  priceOf,
  variantLabel,
  type ProductDetail,
  type ProductSummary,
  type RatingSummary,
  type Review,
} from '@/lib/catalog-api';
import { useWishlist } from '@/components/WishlistProvider';
import { useCart } from '@/components/CartProvider';
import { CartErrorBanner } from '@/components/CartLineControls';
import { useMounted } from '@/lib/useMounted';
import { ProductCard } from '@/components/ProductCard';
import { ProductImage } from '@/components/ProductImage';

const MAX_QTY = 10;

interface Props {
  product: ProductDetail;
  relatedProducts: ProductSummary[];
  reviews: { summary: RatingSummary; reviews: Review[] } | null;
}

function Stars({ value, size = 'h-4 w-4' }: { value: number; size?: string }) {
  return (
    <span className="flex text-[#FF9900]" role="img" aria-label={`${Math.round(value * 10) / 10} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`${size} ${i <= Math.round(value) ? 'fill-[#FF9900]' : 'fill-transparent'}`} />
      ))}
    </span>
  );
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="group py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[14px] font-semibold text-[#113322]">
        {title}
        <ChevronDown className="h-4 w-4 text-[#5F6B64] transition group-open:rotate-180" />
      </summary>
      <div className="pt-2 text-[13px] leading-relaxed text-[#4A5550]">{children}</div>
    </details>
  );
}

/** Share of reviews per star, as bars (whole percentages; display only). */
function RatingBars({ summary }: { summary: RatingSummary }) {
  return (
    <dl className="max-w-sm space-y-1.5" aria-label="Ratings breakdown">
      {(['5', '4', '3', '2', '1'] as const).map((star) => {
        const n = summary.distribution[star] ?? 0;
        const pct = summary.count ? Math.round((n * 100) / summary.count) : 0;
        return (
          <div key={star} className="flex items-center gap-2 text-[12px]">
            <dt className="w-10 shrink-0 text-[#4A5550]">{star} star</dt>
            <dd className="flex flex-1 items-center gap-2">
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#EEF1EF]" aria-hidden>
                <span className="block h-full rounded-full bg-[#FF9900]" style={{ width: `${pct}%` }} />
              </span>
              <span className="w-12 shrink-0 text-right text-[#5F6B64]">
                {n} <span className="sr-only">{n === 1 ? 'review' : 'reviews'}</span>
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const REVIEW_PAGE_SIZE = 6; // the server renders page 1 with this size (catalog-api.getProductReviews)

export function ProductDetailClient({ product, relatedProducts, reviews }: Props) {
  // Further review pages are fetched in the browser (page 1 came with the server render).
  const [moreReviews, setMoreReviews] = useState<Review[]>([]);
  const [reviewPage, setReviewPage] = useState(1);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [reviewsDone, setReviewsDone] = useState(false);
  const loadMoreReviews = async () => {
    setLoadingReviews(true);
    setReviewsError(null);
    try {
      const next = reviewPage + 1;
      const page = await requestApi<Review[]>(
        `/catalog/products/${encodeURIComponent(product.slug)}/reviews?page=${next}&pageSize=${REVIEW_PAGE_SIZE}`,
      );
      // Page 1 came from a cached server render: skip reviews already shown (approvals shift the pages), and stop when
      // the server has no more (the cached count can be higher than what really exists after a moderation).
      setMoreReviews((list) => {
        const seen = new Set([...(reviews?.reviews ?? []), ...list].map((r) => r.id));
        return [...list, ...page.filter((r) => !seen.has(r.id))];
      });
      if (page.length < REVIEW_PAGE_SIZE) setReviewsDone(true);
      setReviewPage(next);
    } catch {
      setReviewsError('More reviews could not be loaded. Please try again.');
    } finally {
      setLoadingReviews(false);
    }
  };
  const router = useRouter();
  const mounted = useMounted();
  const { addItem, pending } = useCart();
  const wishlist = useWishlist();
  const isWishlisted = mounted && wishlist.isSaved(product.slug);
  const toggleWishlist = (slug: string) => void wishlist.toggle(slug);
  const storedCompare = useStore((s) => s.compareSlugs);
  const addToCompare = useStore((s) => s.addToCompare);
  const compareSlugs = mounted ? storedCompare : [];
  const inCompare = compareSlugs.includes(product.slug);

  const firstAvailable = Math.max(0, product.variants.findIndex((v) => v.inStock));
  const [variantIndex, setVariantIndex] = useState(firstAvailable);
  const [quantity, setQuantity] = useState(1);
  const variant = product.variants[variantIndex] ?? product.variants[0]!;
  const { sale, regular, discounted } = priceOf(variant.price);

  // Variant-specific photos first, then shared ones.
  const images = useMemo(() => {
    const withUrl = product.images.filter((i) => i.url);
    const own = withUrl.filter((i) => i.variantId === variant.id);
    const shared = withUrl.filter((i) => !i.variantId);
    const list = own.length ? [...own, ...shared] : shared.length ? shared : withUrl;
    return list;
  }, [product.images, variant.id]);
  const [imageIndex, setImageIndex] = useState(0);
  const image = images[imageIndex] ?? images[0];
  const category = product.categories[0];
  const summary = reviews?.summary;

  const adding = pending.has(variant.id);
  // The server validates stock and limits; errors surface in the cart error banner below.
  const add = async (buyNow: boolean) => {
    const ok = await addItem(variant.id, quantity, !buyNow);
    if (ok && buyNow) router.push('/checkout');
  };

  return (
    <div className="space-y-12">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px] text-[#5F6B64]">
        <Link href="/" className="shrink-0 hover:text-[#116644]">Home</Link>
        <span>/</span>
        {category && (
          <>
            <Link href={`/catalog/${category.slug}`} className="shrink-0 hover:text-[#116644]">{category.name}</Link>
            <span>/</span>
          </>
        )}
        <span className="truncate font-medium text-[#113322]">{product.name}</span>
      </nav>

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:gap-12">
        <div className="min-w-0 space-y-4 lg:col-span-6">
          <div className="relative aspect-square overflow-hidden rounded-3xl border border-[#E6EAE7] bg-white shadow-xs sm:aspect-[4/3]">
            <ProductImage
              src={image?.url}
              alt={image?.altText || product.name}
              priority
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
            {discounted && (
              <span className="absolute left-4 top-4 rounded-full bg-[#FF9900] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#113322] shadow-sm">
                Save {calculateDiscountPercent(regular, sale)}%
              </span>
            )}
            <button
              onClick={() => toggleWishlist(product.slug)}
              type="button"
              aria-pressed={isWishlisted}
              aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
              className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/95 text-[#113322] shadow-sm transition hover:text-red-500"
            >
              <Heart className={`h-5 w-5 ${isWishlisted ? 'fill-red-500 text-red-500' : ''}`} />
            </button>
          </div>

          {images.length > 1 && (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {images.map((img, idx) => (
                <button
                  key={`${img.url}-${idx}`}
                  onClick={() => setImageIndex(idx)}
                  type="button"
                  aria-label={`Show image ${idx + 1}`}
                  aria-current={imageIndex === idx}
                  className={`relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border-2 transition ${
                    imageIndex === idx ? 'border-[#116644]' : 'border-transparent opacity-70 hover:opacity-100'
                  }`}
                >
                  <ProductImage src={img.url} alt="" sizes="80px" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-6 lg:col-span-6">
          <div className="space-y-2">
            {product.brand && (
              <Link
                href={`/catalog?brand=${product.brand.slug}`}
                className="text-[12px] font-bold uppercase tracking-wider text-[#116644] hover:underline"
              >
                {product.brand.name}
              </Link>
            )}
            <h1 className="break-words font-heading text-[28px] font-bold leading-tight text-[#113322] sm:text-[34px]">
              {product.name}
            </h1>
            {product.summary && <p className="text-[15px] text-[#4A5550]">{product.summary}</p>}
            {summary && summary.count > 0 && summary.average !== null && (
              <a href="#reviews" className="flex items-center gap-2 pt-1 text-[13px]">
                <Stars value={summary.average} />
                <span className="font-bold text-[#113322]">{summary.average.toFixed(1)}</span>
                <span className="text-[#5F6B64] underline">
                  {summary.count} {summary.count === 1 ? 'review' : 'reviews'}
                </span>
              </a>
            )}
          </div>

          <div className="space-y-2 rounded-2xl border border-[#E6EAE7] bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-heading text-[32px] font-bold text-[#113322]">{formatPaise(sale)}</span>
              {discounted && (
                <>
                  <span className="text-[18px] text-[#5F6B64] line-through">{formatPaise(regular)}</span>
                  <span className="rounded-full border border-[#FF9900]/30 bg-[#FFF5E6] px-2.5 py-0.5 text-[12px] font-bold text-[#A65500]">
                    SAVE {calculateDiscountPercent(regular, sale)}%
                  </span>
                </>
              )}
            </div>
            <p className="text-[12px] text-[#5F6B64]">Inclusive of {product.gstRateBps / 100}% GST</p>
            <p
              className={`text-[13px] font-semibold ${
                !variant.inStock ? 'text-red-600' : variant.lowStock ? 'text-[#A65500]' : 'text-[#116644]'
              }`}
            >
              {!variant.inStock ? 'Out of stock' : variant.lowStock ? 'Only a few left' : 'In stock'}
            </p>
          </div>

          {product.variants.length > 1 && (
            <fieldset className="space-y-2.5">
              <legend className="mb-2 block text-[13px] font-semibold text-[#113322]">Options</legend>
              <div className="flex flex-wrap gap-2.5">
                {product.variants.map((v, i) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      setVariantIndex(i);
                      setImageIndex(0);
                    }}
                    type="button"
                    aria-pressed={variantIndex === i}
                    className={`rounded-xl px-4 py-2 text-[13px] font-medium transition ${
                      variantIndex === i
                        ? 'bg-[#116644] text-white'
                        : `border border-[#E6EAE7] bg-white hover:border-[#116644] ${v.inStock ? 'text-[#113322]' : 'text-[#5F6B64]'}`
                    } ${v.inStock ? '' : 'line-through'}`}
                  >
                    {variantLabel(v)}
                    {!v.inStock && <span className="sr-only"> (out of stock)</span>}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-12 items-center overflow-hidden rounded-xl border border-[#E6EAE7] bg-white">
              <button
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                disabled={quantity <= 1}
                aria-label="Decrease quantity"
                className="flex h-full items-center px-4 text-[#113322] hover:bg-[#F5F6F5] disabled:opacity-40"
                type="button"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-8 text-center text-[14px] font-bold text-[#113322]" aria-live="polite">{quantity}</span>
              <button
                onClick={() => setQuantity((q) => Math.min(MAX_QTY, q + 1))}
                disabled={quantity >= MAX_QTY}
                aria-label="Increase quantity"
                className="flex h-full items-center px-4 text-[#113322] hover:bg-[#F5F6F5] disabled:opacity-40"
                type="button"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={() => add(false)}
              disabled={!variant.inStock || adding}
              type="button"
              className="h-12 min-w-[140px] flex-1 rounded-xl bg-[#FF9900] text-[15px] font-bold text-[#113322] transition hover:bg-[#e68a00] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!variant.inStock ? 'Out of stock' : adding ? 'Adding…' : 'Add to Cart'}
            </button>
            <button
              onClick={() => add(true)}
              disabled={!variant.inStock || adding}
              type="button"
              className="h-12 min-w-[140px] flex-1 rounded-xl bg-[#116644] text-[15px] font-bold text-white transition hover:bg-[#0e5237] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Buy Now
            </button>
          </div>
          <CartErrorBanner />
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {inCompare ? (
              <Link href="/compare" className="font-semibold text-[#116644] hover:underline">
                ✓ In your comparison — view ({compareSlugs.length})
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => addToCompare(product.slug)}
                disabled={compareSlugs.length >= 4}
                className="inline-flex items-center gap-1.5 font-semibold text-[#116644] hover:underline disabled:cursor-not-allowed disabled:text-[#5F6B64] disabled:no-underline"
              >
                <GitCompare className="h-4 w-4" aria-hidden />
                {compareSlugs.length >= 4 ? 'Compare list is full (4)' : 'Add to compare'}
              </button>
            )}
          </div>

          <div className="divide-y divide-[#E6EAE7] border-t border-[#E6EAE7]">
            {product.descriptionHtml ? (
              <Section title="Description" defaultOpen>
                {/* Sanitised server-side on write (src/common/utils/sanitize-html.ts). */}
                <div className="prose prose-sm max-w-none break-words" dangerouslySetInnerHTML={{ __html: product.descriptionHtml }} />
              </Section>
            ) : null}
            {product.attributes.length > 0 && (
              <Section title="Specifications">
                <dl className="space-y-1">
                  {product.attributes.map((a) => (
                    <div key={a.name} className="flex justify-between gap-4 border-b border-[#F5F6F5] py-1">
                      <dt className="text-[#5F6B64]">{a.name}</dt>
                      <dd className="text-right font-medium text-[#113322]">{a.value}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-4 py-1">
                    <dt className="text-[#5F6B64]">SKU</dt>
                    <dd className="font-medium text-[#113322]">{variant.sku}</dd>
                  </div>
                </dl>
              </Section>
            )}
            <Section title={`GST · ${product.gstRateBps / 100}% included`}>
              Prices include GST at {product.gstRateBps / 100}%. A GST invoice is issued with every order.
            </Section>
            <Section title="Shipping & Returns">
              Delivery charges and timelines are confirmed at checkout for your pincode. Damaged or defective items
              can be returned under our returns policy.
            </Section>
          </div>
        </div>
      </div>

      {relatedProducts.length > 0 && (
        <section className="space-y-6 border-t border-[#E6EAE7] pt-6">
          <h2 className="font-heading text-[22px] font-bold text-[#113322]">You may also like</h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {relatedProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      <section id="reviews" className="space-y-6 rounded-2xl border border-[#E6EAE7] bg-white p-6 md:p-8">
        <h2 className="font-heading text-[22px] font-bold text-[#113322]">Customer reviews</h2>
        <WriteReview slug={product.slug} />
        {!reviews ? (
          <p className="text-[13px] text-[#5F6B64]">Reviews are unavailable right now.</p>
        ) : reviews.summary.count === 0 ? (
          <p className="text-[13px] text-[#5F6B64]">No reviews yet. Customers who buy this product can review it after delivery.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Stars value={reviews.summary.average ?? 0} size="h-5 w-5" />
              <span className="text-[15px] font-bold text-[#113322]">{reviews.summary.average?.toFixed(1)} / 5</span>
              <span className="text-[13px] text-[#5F6B64]">
                {reviews.summary.count} verified {reviews.summary.count === 1 ? 'review' : 'reviews'}
              </span>
            </div>
            <RatingBars summary={reviews.summary} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {[...reviews.reviews, ...moreReviews].map((r) => (
                <article key={r.id} className="min-w-0 space-y-2 rounded-xl border border-[#E6EAE7] bg-[#FAFAFA] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold text-[#113322]">{r.reviewer}</span>
                    <span className="text-[12px] text-[#5F6B64]">{formatIndianDate(r.createdAt)}</span>
                  </div>
                  <Stars value={r.rating} size="h-3.5 w-3.5" />
                  {r.title && <p className="text-[13px] font-semibold text-[#113322]">{r.title}</p>}
                  <p className="whitespace-pre-line break-words text-[13px] text-[#4A5550]">{r.body}</p>
                </article>
              ))}
            </div>
            {!reviewsDone && reviews.reviews.length + moreReviews.length < reviews.summary.count && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => void loadMoreReviews()}
                  disabled={loadingReviews}
                  className="rounded-lg border border-[#116644] px-4 py-2 text-[13px] font-semibold text-[#116644] hover:bg-[#116644]/5 disabled:opacity-50"
                >
                  {loadingReviews ? 'Loading…' : 'Show more reviews'}
                </button>
                {reviewsError && <p role="alert" className="text-[13px] text-red-600">{reviewsError}</p>}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
