'use client';

import { useAdminSession } from '@/components/AdminContext';
import { useAsync } from './useAsync';

/** `useAsync` for admin GETs: a step-up challenge shows the authenticator prompt and then retries the load. */
export function useAdminQuery<T>(load: () => Promise<T>, deps: unknown[]) {
  const { withStepUp } = useAdminSession();
  return useAsync(() => withStepUp(load), deps);
}
