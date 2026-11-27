'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { ApiError } from '@/lib/http';
import { EMPTY_CART, cartErrorMessage, cartRequest, guestToken, mergeGuestCart, type CartView } from '@/lib/cart-api';
import { useStore } from '@/lib/store';

type Status = 'loading' | 'ready' | 'error';

interface CartContextValue {
  cart: CartView;
  status: Status;
  /** Variant ids with a request in flight (to disable their controls). */
  pending: ReadonlySet<string>;
  error: string | null;
  reload: () => Promise<void>;
  addItem: (variantId: string, quantity?: number, openDrawer?: boolean) => Promise<boolean>;
  setQuantity: (variantId: string, quantity: number) => Promise<void>;
  removeItem: (variantId: string) => Promise<void>;
  applyCoupon: (code: string) => Promise<string | null>;
  removeCoupon: () => Promise<void>;
  clearError: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { status: authStatus } = useAuth();
  const signedIn = authStatus === 'authenticated';
  const setDrawerOpen = useStore((s) => s.setCartDrawerOpen);
  const [cart, setCart] = useState<CartView>(EMPTY_CART);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Ignore responses from a previous identity (e.g. a guest request finishing after sign-in).
  const generation = useRef(0);
  // Edits to different lines run in parallel and each answers with the WHOLE cart: never let an older answer that
  // arrives late overwrite a newer one.
  const issued = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    // The edits issued BEFORE this load started are reflected in its answer; later ones are not (they win).
    const seqAtStart = issued.current;
    try {
      let view: CartView;
      // A failed merge (network, 5xx) must not hide the customer's own cart: show it, and keep the guest token so the
      // guest items are merged on a later load.
      if (signedIn) view = (await mergeGuestCart().catch(() => null)) ?? (await cartRequest(true, '/cart'));
      else if (guestToken.get()) view = await cartRequest(false, '/cart');
      else view = EMPTY_CART;
      if (gen !== generation.current) return;
      if (seqAtStart >= applied.current) {
        applied.current = seqAtStart;
        setCart(view && Array.isArray(view.items) ? view : EMPTY_CART);
      } // else: a newer edit already answered with a fresher cart; keep it
      setStatus('ready');
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      if (!signedIn && e instanceof ApiError && e.status === 400) {
        guestToken.clear();
        setCart(EMPTY_CART);
        setStatus('ready');
        return;
      }
      setStatus('error');
      setError(cartErrorMessage(e));
    }
  }, [signedIn]);

  useEffect(() => {
    if (authStatus === 'loading') return;
    // Deferred so state updates happen after the effect, not during it.
    void Promise.resolve().then(load);
  }, [authStatus, load]);

  const mutate = useCallback(
    async (key: string, endpoint: string, init: RequestInit) => {
      const gen = generation.current;
      const seq = ++issued.current;
      setPending((p) => new Set(p).add(key));
      try {
        const view = await cartRequest(signedIn, endpoint, init);
        if (gen === generation.current && seq > applied.current && view && Array.isArray(view.items)) {
          applied.current = seq;
          setCart(view);
          setError(null);
        }
        return view;
      } catch (e) {
        // A 404 on edit means the line or cart vanished (another tab, expiry): resync.
        if (e instanceof ApiError && e.status === 404) void load();
        throw e;
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(key);
          return next;
        });
      }
    },
    [signedIn, load],
  );

  const addItem = useCallback(
    async (variantId: string, quantity = 1, openDrawer = true) => {
      try {
        await mutate(variantId, '/cart/items', { method: 'POST', body: JSON.stringify({ variantId, quantity }) });
        if (openDrawer) setDrawerOpen(true);
        return true;
      } catch (e) {
        setError(cartErrorMessage(e));
        return false;
      }
    },
    [mutate, setDrawerOpen],
  );

  const setQuantity = useCallback(
    async (variantId: string, quantity: number) => {
      try {
        if (quantity < 1) await mutate(variantId, `/cart/items/${variantId}`, { method: 'DELETE' });
        else
          await mutate(variantId, `/cart/items/${variantId}`, {
            method: 'PATCH',
            body: JSON.stringify({ quantity }),
          });
      } catch (e) {
        setError(cartErrorMessage(e));
      }
    },
    [mutate],
  );

  const removeItem = useCallback(
    async (variantId: string) => {
      try {
        await mutate(variantId, `/cart/items/${variantId}`, { method: 'DELETE' });
      } catch (e) {
        setError(cartErrorMessage(e));
      }
    },
    [mutate],
  );

  const applyCoupon = useCallback(
    async (code: string) => {
      try {
        await mutate('coupon', '/cart/coupon', { method: 'POST', body: JSON.stringify({ code }) });
        return null;
      } catch (e) {
        return cartErrorMessage(e);
      }
    },
    [mutate],
  );

  const removeCoupon = useCallback(async () => {
    try {
      await mutate('coupon', '/cart/coupon', { method: 'DELETE' });
    } catch (e) {
      setError(cartErrorMessage(e));
    }
  }, [mutate]);

  const value = useMemo(
    () => ({
      cart,
      status,
      pending,
      error,
      reload: load,
      addItem,
      setQuantity,
      removeItem,
      applyCoupon,
      removeCoupon,
      clearError: () => setError(null),
    }),
    [cart, status, pending, error, load, addItem, setQuantity, removeItem, applyCoupon, removeCoupon],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

/** Units in the cart, counting every line (also those that need attention), so header, drawer and cart page agree. */
export const cartUnits = (cart: CartView): number => cart.items.reduce((n, i) => n + i.quantity, 0);

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
