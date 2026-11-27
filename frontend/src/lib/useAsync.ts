'use client';

import { useCallback, useEffect, useState, type SetStateAction } from 'react';

interface State<T> {
  key: string | null;
  data: T | null;
  error: string | null;
}

/** Loads data on mount / when `deps` change. `reload()` re-runs it. Errors become a user-facing message. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [tick, setTick] = useState(0);
  const key = JSON.stringify([...deps, tick]);
  const [state, setState] = useState<State<T>>({ key: null, data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setState({ key, data, error: null }),
      (e: unknown) =>
        !cancelled &&
        setState((s) => ({ key, data: s.data, error: e instanceof Error && e.message ? e.message : 'Something went wrong.' })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback(
    (v: SetStateAction<T | null>) =>
      setState((s) => ({ ...s, data: typeof v === 'function' ? (v as (p: T | null) => T | null)(s.data) : v })),
    [],
  );
  const loading = state.key !== key;
  return { data: state.data, setData, error: loading ? null : state.error, loading, reload };
}

/** One page of a list plus whether another page exists, from the API's `meta` (never guessed from the page size). */
export interface Paged<T> {
  items: T[];
  total: number;
  hasNext: boolean;
}

/** `useAsync` for a paged list: `data` is the page's items, `hasNext` comes from the server. */
export function usePaged<T>(load: () => Promise<Paged<T>>, deps: unknown[]) {
  const r = useAsync(load, deps);
  const { setData: setPage } = r;
  const setData = useCallback(
    (v: SetStateAction<T[] | null>) =>
      setPage((p) => {
        if (!p) return p;
        const items = typeof v === 'function' ? (v as (prev: T[] | null) => T[] | null)(p.items) : v;
        return { ...p, items: items ?? [] };
      }),
    [setPage],
  );
  return {
    data: r.data?.items ?? null,
    hasNext: r.data?.hasNext ?? false,
    total: r.data?.total ?? 0,
    setData,
    error: r.error,
    loading: r.loading,
    reload: r.reload,
  };
}

