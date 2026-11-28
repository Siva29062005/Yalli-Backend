import Link from 'next/link';
import { OLD_STORE_NOTICE } from '@/lib/business';

/** Shown on sign-in and sign-up after the move from the old website (NEXT_PUBLIC_OLD_STORE_NOTICE=1). */
export function OldStoreNotice() {
  if (!OLD_STORE_NOTICE) return null;
  return (
    <aside aria-label="About accounts from our old website" className="rounded-xl border border-[#D9E3DC] bg-[#F3F7F4] px-4 py-3 text-[13px] leading-relaxed text-[#113322]">
      <p>
        <strong>New website.</strong> Accounts from our old website were not moved here, because passwords cannot be moved
        safely. If you shopped with us before, please{' '}
        <Link href="/auth/register" className="font-semibold text-[#116644] underline">
          create a new account
        </Link>
        . For an order placed on the old website,{' '}
        <Link href="/contact" className="font-semibold text-[#116644] underline">
          contact us
        </Link>
        .
      </p>
    </aside>
  );
}
