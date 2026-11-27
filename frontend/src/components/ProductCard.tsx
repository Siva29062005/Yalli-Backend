'use client';

import Link from 'next/link';
import { Heart, Star } from 'lucide-react';
import { formatPaise, calculateDiscountPercent } from '@/lib/formatters';
import { priceOf, type ProductSummary } from '@/lib/catalog-api';
import { useWishlist } from '@/components/WishlistProvider';
import { useMounted } from '@/lib/useMounted';
import { ProductImage } from '@/components/ProductImage';

export function ProductCard({
  product,
  priority,
}: {
  product: ProductSummary;
  priority?: boolean;
}) {
  const mounted = useMounted();
  const wishlist = useWishlist();
  const isWishlisted = mounted && wishlist.isSaved(product.slug);
  const toggleWishlist = (slug: string) => void wishlist.toggle(slug);
  const { sale, regular, discounted } = priceOf(product.price);
  const href = `/products/${product.slug}`;

  return (
    <article className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[#E6EAE7] bg-white transition-all duration-200 hover:border-[#116644]/30 hover:shadow-lg">
      <div className="relative aspect-[4/3] overflow-hidden bg-[#F7F8F7]">
        <Link href={href} className="absolute inset-0" tabIndex={-1} aria-hidden>
          <ProductImage
            src={product.imageUrl}
            alt={product.name}
            priority={priority}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className="transition-transform duration-300 group-hover:scale-105"
          />
        </Link>

        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5">
          {discounted && (
            <span className="rounded-full bg-[#FF9900] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#113322] shadow-sm">
              {calculateDiscountPercent(regular, sale)}% off
            </span>
          )}
          {!product.inStock && (
            <span className="rounded-full bg-[#113322]/80 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
              Out of stock
            </span>
          )}
        </div>

        <button
          onClick={() => toggleWishlist(product.slug)}
          type="button"
          aria-pressed={isWishlisted}
          aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Add ${product.name} to wishlist`}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-[#113322] shadow-xs transition hover:bg-white hover:text-red-500"
        >
          <Heart className={`h-4 w-4 ${isWishlisted ? 'fill-red-500 text-red-500' : ''}`} />
        </button>
      </div>

      <div className="flex flex-1 flex-col justify-between p-4">
        <div className="mb-3 min-w-0 space-y-1">
          {product.brand?.name && (
            <span className="block truncate text-[11px] font-semibold uppercase tracking-wider text-[#5F6B64]">
              {product.brand.name}
            </span>
          )}
          <Link
            href={href}
            className="line-clamp-2 break-words text-[15px] font-medium text-[#113322] transition hover:text-[#116644]"
          >
            {product.name}
          </Link>
          {product.rating && product.rating.count > 0 && product.rating.average !== null && (
            <span
              className="flex items-center gap-1 text-[12px] text-[#4A5550]"
              aria-label={`Rated ${product.rating.average.toFixed(1)} out of 5 from ${product.rating.count} reviews`}
            >
              <Star className="h-3.5 w-3.5 fill-[#FF9900] text-[#FF9900]" aria-hidden />
              <span className="font-semibold text-[#113322]">{product.rating.average.toFixed(1)}</span>
              <span className="text-[#5F6B64]">({product.rating.count})</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#F0F2F1] pt-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[17px] font-bold text-[#A65500]">
              {product.price.fromPrice && <span className="mr-1 text-[12px] font-semibold text-[#5F6B64]">From</span>}
              {formatPaise(sale)}
            </span>
            {discounted && (
              <span className="text-[13px] text-[#5F6B64] line-through">{formatPaise(regular)}</span>
            )}
          </div>
          <Link
            href={href}
            className="shrink-0 rounded-md border border-[#116644] px-3 py-1 text-[13px] font-semibold text-[#116644] transition hover:bg-[#116644] hover:text-white"
          >
            {product.inStock ? 'View' : 'Details'}
          </Link>
        </div>
      </div>
    </article>
  );
}
