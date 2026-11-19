'use client';

import { createContext, useContext } from 'react';
import type { AdminIdentity } from '@/lib/admin-session';

export interface AdminSession {
  identity: AdminIdentity;
  signOut: () => Promise<void>;
  /**
   * Runs an admin API call. When the server asks for a fresh MFA step-up, shows the authenticator prompt,
   * and retries the call once after the staff member verifies. Cancelling rejects with a plain Error.
   */
  withStepUp: <T>(call: () => Promise<T>) => Promise<T>;
  /**
   * Whether the signed-in staff member's role holds this permission (as reported by the server for THIS account).
   * Use it to hide buttons that would only produce a 403. It is not a security control: the API enforces every
   * permission itself.
   */
  can: (permission: string) => boolean;
}

export const AdminContext = createContext<AdminSession | null>(null);

export function useAdminSession() {
  const session = useContext(AdminContext);
  if (!session) throw new Error('Staff authentication is required.');
  return session;
}
