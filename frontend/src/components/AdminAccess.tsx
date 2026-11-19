'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { adminLogin, adminLogout, adminRequest, adminStepUp, adminVerify, clearAdminSession, restoreAdminSession, type AdminIdentity } from '@/lib/admin-session';
import { ApiError } from '@/lib/http';
import { canOpen, screenFor } from '@/lib/admin-access';
import { AdminContext } from './AdminContext';
import { AdminNoAccess } from './AdminNoAccess';

interface StepUpWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export { useAdminSession } from './AdminContext';

/** `/me` for a staff account; `permissions` is null when an older backend does not send it (nothing is hidden then). */
const toIdentity = (user: AdminIdentity): AdminIdentity => ({ ...user, permissions: Array.isArray(user.permissions) ? user.permissions : null });

const staffRoles = ['SUPER_ADMIN', 'ADMIN', 'PRODUCT_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'FINANCE_MANAGER', 'CUSTOMER_SUPPORT'];
const inputClass = 'mt-1 w-full min-w-0 rounded-xl border border-[#DCE3DE] bg-white px-3 py-2.5 text-sm';

export function AdminAccess({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(true);
  const [stepUpWaiter, setStepUpWaiter] = useState<StepUpWaiter | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // After a reload, swap the HttpOnly refresh cookie for a new access token and re-check staff access.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!(await restoreAdminSession())) return;
        const user = await adminRequest<AdminIdentity>('/me');
        if (!active) return;
        if (user.mfaEnabled && user.roles.some((role) => staffRoles.includes(role))) {
          setIdentity(toIdentity(user));
          if (pathname === '/admin/login') router.replace('/admin');
        } else {
          await adminLogout().catch(() => clearAdminSession());
        }
      } catch {
        clearAdminSession();
      } finally {
        if (active) setRestoring(false);
      }
    })();
    return () => {
      active = false;
    };
    // Runs once per page load. Later navigation keeps the in-memory session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const expire = () => {
      clearAdminSession();
      setIdentity(null);
      setPassword('');
      setChallenge('');
      setCode('');
      setError('Your staff session expired. Please sign in again.');
    };
    window.addEventListener('admin-session-expired', expire);
    return () => {
      window.removeEventListener('admin-session-expired', expire);
    };
  }, []);

  async function signOut() {
    setIdentity(null);
    setChallenge('');
    setCode('');
    setError('');
    try {
      await adminLogout();
    } catch {
      setError('Signed out locally. Server sign-out could not be confirmed.');
    } finally {
      router.replace('/admin/login');
    }
  }

  // Screens load several things at once: every call that needs a step-up shares ONE prompt.
  // A plain holder (not a ref) because it lives inside the callback handed to every admin screen.
  const [stepUpPrompt] = useState<{ current: Promise<void> | null }>(() => ({ current: null }));
  const withStepUp = useCallback(async <T,>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'STEP_UP_REQUIRED') throw error;
    }
    stepUpPrompt.current ??= new Promise<void>((resolve, reject) =>
      setStepUpWaiter({
        resolve: () => {
          stepUpPrompt.current = null;
          resolve();
        },
        reject: (e) => {
          stepUpPrompt.current = null;
          reject(e);
        },
      }),
    );
    await stepUpPrompt.current;
    return call();
  }, [stepUpPrompt]);

  const session = useMemo(
    () => (identity ? { identity, signOut, withStepUp, can: (permission: string) => identity.permissions === null || identity.permissions.includes(permission) } : null),
    // signOut only closes over stable setters and the router.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, withStepUp],
  );

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!challenge) {
        const result = await adminLogin(email, password);
        setPassword('');
        if (!result.mfaRequired || !result.mfaToken) {
          await adminLogout().catch(() => clearAdminSession());
          throw new Error('Admin access requires a staff account with MFA enabled. Contact your administrator.');
        }
        setChallenge(result.mfaToken);
        return;
      }
      await adminVerify(challenge, code);
      const user = await adminRequest<AdminIdentity>('/me');
      if (!user.mfaEnabled || !user.roles.some((role) => staffRoles.includes(role))) {
        await adminLogout().catch(() => clearAdminSession());
        throw new Error('This account does not have staff access with MFA enabled.');
      }
      setIdentity(toIdentity(user));
      setChallenge('');
      setCode('');
      if (pathname === '/admin/login') router.replace('/admin');
    } catch (error) {
      clearAdminSession();
      setCode('');
      setError(error instanceof Error ? error.message : 'Unable to sign in. Please try again.');
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  const screen = screenFor(pathname);
  if (session) {
    return (
      <AdminContext.Provider value={session}>
        {screen && !canOpen(session.identity.permissions, screen) ? <AdminNoAccess screen={screen} /> : children}
        {stepUpWaiter && (
          <StepUpDialog
            onVerified={() => {
              stepUpWaiter.resolve();
              setStepUpWaiter(null);
            }}
            onCancel={() => {
              stepUpWaiter.reject(new Error('Verification cancelled. Your change was not saved.'));
              setStepUpWaiter(null);
            }}
          />
        )}
      </AdminContext.Provider>
    );
  }

  if (restoring) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F7F9F8]" aria-busy="true">
        <p className="text-sm text-[#4A5550]">Checking your staff session…</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F7F9F8] px-4 py-12">
      <section className="w-full max-w-md rounded-2xl border border-[#E6EAE7] bg-white p-6 shadow-sm sm:p-8">
        <p className="mb-6 font-heading text-2xl font-bold text-[#116644]">yalli · Staff workspace</p>
        <h1 className="text-2xl font-bold">Secure admin sign in</h1>
        <p className="my-4 text-sm text-[#4A5550]">Staff only. Your password and authenticator verification are required before accessing any admin page.</p>
        {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <form onSubmit={signIn} className="space-y-4">
          {challenge ? (
            <label className="block text-sm font-medium">Authenticator code
              <input autoFocus required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className={inputClass} value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
          ) : (
            <>
              <label className="block text-sm font-medium">Work email
                <input required type="email" autoComplete="username" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="block text-sm font-medium">Password
                <input required type="password" autoComplete="current-password" maxLength={128} className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
            </>
          )}
          <button disabled={busy} className="w-full rounded-xl bg-[#116644] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Verifying…' : challenge ? 'Verify and continue' : 'Continue'}</button>
          {challenge && <button type="button" disabled={busy} className="text-sm underline" onClick={() => { setChallenge(''); setCode(''); setError(''); }}>Start again</button>}
        </form>
        <Link href="/" className="mt-6 inline-block text-sm text-[#116644] underline">Back to storefront</Link>
      </section>
    </main>
  );
}

function StepUpDialog({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminStepUp(code);
      onVerified();
    } catch (e) {
      setCode('');
      setError(e instanceof Error ? e.message : 'Verification failed. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="stepup-title"
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 id="stepup-title" className="text-lg font-bold">Confirm it&apos;s you</h2>
        <p className="text-sm text-[#4A5550]">This action needs a fresh authenticator code. Your change continues right after you verify.</p>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <label className="block text-sm font-medium">Authenticator code
          <input autoFocus required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-[#4A5550]">Cancel</button>
          <button disabled={busy} className="rounded-xl bg-[#116644] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Verifying…' : 'Verify'}</button>
        </div>
      </form>
    </div>
  );
}
