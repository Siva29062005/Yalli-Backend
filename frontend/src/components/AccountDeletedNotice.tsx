'use client';

import { useSearchParams } from 'next/navigation';

/** Shown on the home page after a customer deleted their account (`/?account=deleted`). */
export function AccountDeletedNotice() {
  if (useSearchParams().get('account') !== 'deleted') return null;
  return (
    <p role="status" className="rounded-2xl border border-[#D5EAD9] bg-[#EEFFEE] px-5 py-3 text-[14px] text-[#116644]">
      Your account has been deleted and you have been signed out. Thank you for shopping with us.
    </p>
  );
}
