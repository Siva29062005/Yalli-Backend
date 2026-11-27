'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  CUSTOMER_SESSION_EXPIRED,
  customerSession,
  type CustomerProfile,
} from '@/lib/customer-session';
import type { LoginResult } from '@/lib/token-session';
import { ApiError } from '@/lib/http';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: CustomerProfile | null;
  login: (email: string, password: string, remember: boolean) => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, factor: { code: string } | { recoveryCode: string }, remember: boolean) => Promise<void>;
  logout: (redirectTo?: string) => Promise<void>;
  /** The server already ended the session (account deleted, signed out everywhere): forget it here and in every tab. */
  endLocally: (redirectTo: string) => void;
  refreshProfile: () => Promise<CustomerProfile | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const SESSION_CHANNEL = 'yalli-customer-session';
/** Identifies this tab, so it ignores its own logout broadcast (BroadcastChannel delivers to every other object). */
const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());

function broadcastLogout() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type: 'logout', from: TAB_ID });
  channel.close();
}

/** Retry /me only for a blip (network, timeout, 5xx). 401/403 = signed out; 429 and other 4xx are not retried. */
const transient = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<CustomerProfile | null>(null);

  const refreshProfile = useCallback(async () => {
    // Only "you are not signed in" (401) signs the user out. A network blip or a 5xx is retried a few times first, so a
    // momentary outage does not throw a valid session away.
    for (let attempt = 0; ; attempt++) {
      try {
        const me = await customerSession.request<CustomerProfile>('/me');
        setUser(me);
        setStatus('authenticated');
        return me;
      } catch (e) {
        if (!transient(e) || attempt >= 2) {
          // Signed out (or still failing): forget the session completely, so state and tokens agree.
          customerSession.clear();
          setUser(null);
          setStatus('anonymous');
          return null;
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
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
    // Signing out in one tab signs out every tab of this browser (they share the refresh cookie).
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SESSION_CHANNEL) : null;
    if (channel)
      channel.onmessage = (m) => {
        const msg = m.data as { type?: string; from?: string } | null;
        if (msg?.type !== 'logout' || msg.from === TAB_ID) return; // our own sign-out is handled by logout()
        customerSession.clear();
        expire();
      };
    return () => {
      active = false;
      window.removeEventListener(CUSTOMER_SESSION_EXPIRED, expire);
      channel?.close();
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
      broadcastLogout();
      if (redirectTo) window.location.replace(redirectTo);
      else {
        setUser(null);
        setStatus('anonymous');
      }
    }
  }, []);

  const endLocally = useCallback((redirectTo: string) => {
    customerSession.clear(); // no /auth/logout: the session is already gone, a call would only fail and refresh
    broadcastLogout();
    window.location.replace(redirectTo);
  }, []);

  const value = useMemo(
    () => ({ status, user, login, verifyMfa, logout, endLocally, refreshProfile }),
    [status, user, login, verifyMfa, logout, endLocally, refreshProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
