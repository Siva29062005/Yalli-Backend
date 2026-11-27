'use client';

import Link from 'next/link';
import { errorReference } from '@/lib/error-reference';

/**
 * Staff workspace crash screen. It shows no technical detail, and stays inside the admin layout so the staff sign-in
 * check is not bypassed. A save that was in progress may not have gone through, so staff are told to re-check.
 */
export default function AdminError({ error, retry }: { error: unknown; retry: () => void }) {
  const reference = errorReference(error);
  return (
    <main role="alert" className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-center justify-center gap-4 px-4 py-20 text-center">
      <h1 className="font-heading text-[26px] font-bold text-[#113322]">This screen hit a problem</h1>
      <p className="text-[15px] text-[#4A5550]">
        If you were saving something when this appeared, check whether the change was applied before you repeat it. Then try again.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-xl bg-[#116644] px-6 py-3 text-[14px] font-semibold text-white hover:bg-[#0e5237] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116644]"
        >
          Try again
        </button>
        <Link href="/admin" className="text-[14px] font-semibold text-[#116644] underline">Back to the staff workspace</Link>
      </div>
      {reference && <p className="text-[12px] text-[#5F6B64]">Reference for the developers: {reference}</p>}
    </main>
  );
}
