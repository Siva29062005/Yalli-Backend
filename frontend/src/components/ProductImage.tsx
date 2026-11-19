import Image from 'next/image';
import { ImageOff } from 'lucide-react';

/** Product photo with a neutral placeholder when the catalogue has no image yet. */
export function ProductImage({
  src,
  alt,
  sizes,
  priority,
  className = '',
}: {
  src: string | null | undefined;
  alt: string;
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  if (!src) {
    return (
      <div
        role="img"
        aria-label={`${alt} (image coming soon)`}
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#F2F4F3] text-[#A3ADA7]"
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
      priority={priority}
      // Media is served from the configured CDN/bucket; skip the optimiser so new hosts don't need config changes.
      unoptimized={!src.startsWith('https://images.unsplash.com')}
      className={`object-cover ${className}`}
    />
  );
}
