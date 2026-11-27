'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { accountApi } from '@/lib/account-api';

interface WishlistContextValue {
  /** Slugs saved on the server for the signed-in customer. Empty for guests. */
  slugs: Set<string>;
  ready: boolean;
  isSaved: (slug: string) => boolean;
  /** Guests are sent to sign in first. Resolves to the new saved state. */
  toggle: (slug: string) => Promise<boolean>;
  /** Called by the wishlist page after it removes an item itself. */
  forget: (slug: string) => void;
  error: string | null;
}

const WishlistContext = createContext<WishlistContextValue | null>(null);
const EMPTY = new Set<string>();
const MAX_PAGES = 4; // 4 × 60 covers the backend's 200-item limit

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const userId = status === 'authenticated' ? user?.id ?? null : null;
  const router = useRouter();
  const pathname = usePathname();
  // Slugs are tagged with the account they were loaded for, so a sign-out or account switch never shows stale hearts.
  const [loaded, setLoaded] = useState<{ owner: string; slugs: Set<string> } | null>(null);
  const slugs = useMemo(() => (loaded && loaded.owner === userId ? loaded.slugs : EMPTY), [loaded, userId]);
  const ready = status === 'anonymous' || (!!userId && loaded?.owner === userId);
  const setSlugs = useCallback(
    (fn: (prev: Set<string>) => Set<string>) =>
      setLoaded((l) => (l && userId && l.owner === userId ? { owner: userId, slugs: fn(l.slugs) } : l)),
    [userId],
  );
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const found = new Set<string>();
      try {
        for (let p = 1; p <= MAX_PAGES; p++) {
          const { items, hasNext } = await accountApi.wishlist(p, 60);
          items.forEach((i) => found.add(i.slug));
          if (!hasNext) break; // from the server's meta: a short page can still be followed by more
        }
      } catch {
        /* the hearts just show as unsaved; the wishlist page reports errors itself */
      }
      if (!cancelled) setLoaded({ owner: userId, slugs: found });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggle = useCallback(
    async (slug: string) => {
      if (status !== 'authenticated') {
        router.push(`/auth/login?next=${encodeURIComponent(pathname + window.location.search)}`);
        return false;
      }
      if (pending.current.has(slug)) return slugs.has(slug);
      pending.current.add(slug);
      const wasSaved = slugs.has(slug);
      const apply = (saved: boolean) =>
        setSlugs((prev) => {
          const next = new Set(prev);
          if (saved) next.add(slug);
          else next.delete(slug);
          return next;
        });
      apply(!wasSaved); // optimistic
      setError(null);
      try {
        if (wasSaved) await accountApi.removeFromWishlist(slug);
        else await accountApi.saveToWishlist(slug);
        return !wasSaved;
      } catch (e) {
        apply(wasSaved);
        setError(e instanceof Error ? e.message : 'Could not update your wishlist.');
        return wasSaved;
      } finally {
        pending.current.delete(slug);
      }
    },
    [status, slugs, setSlugs, router, pathname],
  );

  const forget = useCallback((slug: string) => {
    setSlugs((prev) => {
      const next = new Set(prev);
      next.delete(slug);
      return next;
    });
  }, [setSlugs]);

  const value = useMemo(
    () => ({ slugs, ready, isSaved: (s: string) => slugs.has(s), toggle, forget, error }),
    [slugs, ready, toggle, forget, error],
  );
  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error('useWishlist must be used inside WishlistProvider');
  return ctx;
}
