'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';

/**
 * Account pages need a signed-in customer. This is a UX gate only: every account API call
 * is authorised by the backend regardless.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      const next = pathname + window.location.search;
      router.replace(`/auth/login?next=${encodeURIComponent(next)}`);
    }
  }, [status, pathname, router]);

  if (status !== 'authenticated') {
    return (
      <main className="flex-1 flex items-center justify-center py-32" role="status">
        <Loader2 className="w-8 h-8 text-[#116644] animate-spin" aria-hidden />
        <span className="sr-only">Checking your session…</span>
      </main>
    );
  }
  return <>{children}</>;
}
