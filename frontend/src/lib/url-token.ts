'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Reads the one-time `token` of an email link (password reset, email verification) ONCE, then removes it from the
 * address bar and the history entry, so it is not left in browser history or a shared screenshot. The value is kept in
 * state (Next updates useSearchParams when the URL changes). Reloading afterwards needs the link again; the link itself
 * keeps working until the token is used.
 */
export function useUrlToken(): string | null {
  const params = useSearchParams();
  const [token] = useState(() => params.get('token'));
  useEffect(() => {
    if (!token) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [token]);
  return token;
}
