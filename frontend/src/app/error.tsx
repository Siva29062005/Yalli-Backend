'use client';

import Link from 'next/link';
import { errorReference } from '@/lib/error-reference';

/**
 * Last-resort screen for a page that crashed while rendering. It deliberately shows no error text or stack (they can
 * contain internals) and does not render the store header or footer, which may be the part that failed.
 * Next.js 16 passes `retry`, which re-fetches and re-renders the segment.
 */
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  const reference = errorReference(error);
  return (
    <main id="content" role="alert" className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-20 text-center">
      <h1 className="font-heading text-[28px] font-bold text-[#113322]">Something went wrong</h1>
      <p className="text-[15px] text-[#4A5550]">
        We couldn’t show this page. Your cart and orders are safe. Please try again, and if it keeps happening, tell us.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-xl bg-[#116644] px-6 py-3 text-[14px] font-semibold text-white hover:bg-[#0e5237] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116644]"
        >
          Try again
        </button>
        <Link href="/" className="text-[14px] font-semibold text-[#116644] underline">Go to the home page</Link>
        <Link href="/contact" className="text-[14px] font-semibold text-[#116644] underline">Contact us</Link>
      </div>
      {reference && <p className="text-[12px] text-[#8A958E]">Reference: {reference}</p>}
    </main>
  );
}
