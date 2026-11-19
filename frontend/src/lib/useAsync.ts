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
