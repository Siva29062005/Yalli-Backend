'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  CUSTOMER_SESSION_EXPIRED,
  customerSession,
  type CustomerProfile,
} from '@/lib/customer-session';
import type { LoginResult } from '@/lib/token-session';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: CustomerProfile | null;
  login: (email: string, password: string, remember: boolean) => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, factor: { code: string } | { recoveryCode: string }, remember: boolean) => Promise<void>;
  logout: (redirectTo?: string) => Promise<void>;
  refreshProfile: () => Promise<CustomerProfile | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<CustomerProfile | null>(null);

  const refreshProfile = useCallback(async () => {
    try {
      const me = await customerSession.request<CustomerProfile>('/me');
      setUser(me);
      setStatus('authenticated');
      return me;
    } catch {
      setUser(null);
      setStatus('anonymous');
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    customerSession.restore().then((ok) => {
      if (!active) return;
      if (ok) void refreshProfile();
      else setStatus('anonymous');
    });
    const expire = () => {
      setUser(null);
      setStatus('anonymous');
    };
    window.addEventListener(CUSTOMER_SESSION_EXPIRED, expire);
    return () => {
      active = false;
      window.removeEventListener(CUSTOMER_SESSION_EXPIRED, expire);
    };
  }, [refreshProfile]);

  const login = useCallback(
    async (email: string, password: string, remember: boolean) => {
      const result = await customerSession.login(email, password, remember);
      if (!result.mfaRequired) await refreshProfile();
      return result;
    },
    [refreshProfile],
  );

  const verifyMfa = useCallback(
    async (mfaToken: string, factor: { code: string } | { recoveryCode: string }, remember: boolean) => {
      await customerSession.verifyMfa(mfaToken, factor, remember);
      await refreshProfile();
    },
    [refreshProfile],
  );

  /**
   * With `redirectTo`, does a full page load instead of a state update. That stops guarded pages
   * from bouncing to the login screen mid-logout and drops any in-memory data of the old session.
   */
  const logout = useCallback(async (redirectTo?: string) => {
    try {
      await customerSession.logout();
    } finally {
      if (redirectTo) window.location.replace(redirectTo);
      else {
        setUser(null);
        setStatus('anonymous');
      }
    }
  }, []);

  const value = useMemo(
    () => ({ status, user, login, verifyMfa, logout, refreshProfile }),
    [status, user, login, verifyMfa, logout, refreshProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
