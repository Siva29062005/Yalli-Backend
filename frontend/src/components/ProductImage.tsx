import Image from 'next/image';
import { ImageOff } from 'lucide-react';

/** Product photo with a neutral placeholder when the catalogue has no image yet. */
export function ProductImage({
  src,
  alt,
  sizes,
  priority,
  fit = 'cover',
  className = '',
}: {
  src: string | null | undefined;
  alt: string;
  sizes: string;
  /** Preload it (the main image of a page). Passed to next/image as `preload` (`priority` is deprecated in Next 16). */
  priority?: boolean;
  /** cover fills the box (cards); contain shows the whole photo (hero). */
  fit?: 'cover' | 'contain';
  className?: string;
}) {
  if (!src) {
    return (
      <div
        role="img"
        aria-label={`${alt} (image coming soon)`}
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#F2F4F3] text-[#5F6B64]"
      >
        <ImageOff className="h-7 w-7" aria-hidden />
        <span className="text-[11px] font-medium">Image coming soon</span>
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      preload={priority}
      // Media is served from the configured CDN/bucket; skip the optimiser so new hosts don't need config changes.
      unoptimized={!src.startsWith('https://images.unsplash.com')}
      className={`${fit === 'contain' ? 'object-contain' : 'object-cover'} ${className}`}
    />
  );
}
