'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { FormAlert, inputClass, primaryButtonClass } from '@/components/AuthShell';
import { errorMessage, resendVerification } from '@/lib/auth-api';
import { safeNext } from '@/lib/customer-session';
import { ApiError } from '@/lib/http';

type Step = { kind: 'credentials' } | { kind: 'mfa'; mfaToken: string };

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const { status, login, verifyMfa } = useAuth();

  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);

  // Already signed in (e.g. restored session): go straight on.
  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnverified(false);
    try {
      const result = await login(email.trim(), password, remember);
      if (result.mfaRequired && result.mfaToken) {
        setStep({ kind: 'mfa', mfaToken: result.mfaToken });
        setPassword('');
      } else {
        router.replace(next);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      setError(errorMessage(err, 'We could not sign you in. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'mfa') return;
    setBusy(true);
    setError(null);
    try {
      const value = code.trim();
      await verifyMfa(step.mfaToken, useRecovery ? { recoveryCode: value } : { code: value }, remember);
      router.replace(next);
    } catch (err) {
      setCode('');
      // An expired/used challenge can't be retried: send the user back to the password step.
      if (err instanceof ApiError && err.status === 401 && /expired|sign in again/i.test(err.message)) {
        setStep({ kind: 'credentials' });
      }
      setError(errorMessage(err, 'That code did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      await resendVerification(email.trim());
    } finally {
      setResent(true);
    }
  };

  if (step.kind === 'mfa') {
    return (
      <>
        <div className="space-y-1">
          <span className="text-[11px] font-bold text-[#116644] tracking-wider uppercase">Two-step verification</span>
          <h1 className="font-heading text-[28px] sm:text-[32px] font-bold text-[#113322]">One more step.</h1>
          <p className="text-[14px] text-[#8A958E]">
            {useRecovery
              ? 'Enter one of the recovery codes you saved when you set up two-step verification.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>
        </div>
        <form onSubmit={submitMfa} className="space-y-4" noValidate>
          {error && <FormAlert>{error}</FormAlert>}
          <div className="space-y-1.5">
            <label htmlFor="mfa-code" className="text-[12px] font-semibold text-[#113322]">
              {useRecovery ? 'Recovery code' : 'Authentication code'}
            </label>
            <input
              id="mfa-code"
              autoFocus
              required
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              maxLength={useRecovery ? 32 : 6}
              value={code}
              onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ''))}
              className={`${inputClass} ${useRecovery ? '' : 'text-center text-[18px] font-bold tracking-[0.4em]'}`}
            />
          </div>
          <button
            type="submit"
            disabled={busy || (useRecovery ? code.trim().length < 8 : code.length !== 6)}
            className={primaryButtonClass}
          >
            {busy ? 'Verifying…' : 'Verify and log in →'}
          </button>
        </form>
        <div className="flex flex-wrap justify-between gap-2 text-[13px]">
          <button
            type="button"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode('');
              setError(null);
            }}
            className="text-[#116644] font-semibold hover:underline"
          >
            {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep({ kind: 'credentials' });
              setCode('');
              setError(null);
            }}
            className="text-[#8A958E] hover:text-[#113322]"
          >
            ← Start over
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[#116644] tracking-wider uppercase">Welcome back</span>
        <h1 className="font-heading text-[28px] sm:text-[32px] font-bold text-[#113322]">Home is a login away.</h1>
        <p className="text-[14px] text-[#8A958E]">Sign in for your favourites, orders and everyday joys.</p>
      </div>

      {params.get('reset') === '1' && !error && (
        <FormAlert tone="success">Your password was updated. Please sign in with the new one.</FormAlert>
      )}
      {params.get('verified') === '1' && !error && (
        <FormAlert tone="success">Your email is verified. You can sign in now.</FormAlert>
      )}

      <form onSubmit={submitCredentials} className="space-y-4">
        {error && (
          <FormAlert>
            {error}
            {unverified && (
              <div className="pt-1">
                {resent ? (
                  <span>If the account needs it, a new verification email is on its way.</span>
                ) : (
                  <button type="button" onClick={resend} className="font-semibold underline">
                    Resend verification email
                  </button>
                )}
              </div>
            )}
          </FormAlert>
        )}
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-[12px] font-semibold text-[#113322]">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-[12px] font-semibold text-[#113322]">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputClass} pr-16`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[#8A958E] hover:text-[#113322]"
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="rounded text-[#116644]"
            />
            <span className="text-[#4A5550]">Keep me signed in</span>
          </label>
          <Link href="/auth/reset-password" className="text-[#116644] hover:underline font-medium">
            Forgot password?
          </Link>
        </div>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? 'Signing in…' : 'Log in →'}
        </button>
      </form>

      <div className="text-center pt-2">
        <Link
          href={next === '/account/profile' ? '/auth/register' : `/auth/register?next=${encodeURIComponent(next)}`}
          className="text-[13px] text-[#116644] font-semibold hover:underline"
        >
          New here? Register for a little more joy →
        </Link>
      </div>
      <div className="bg-[#EEFFEE]/60 text-center py-2.5 px-4 rounded-xl text-[12px] text-[#116644]">
        Your details stay safe. Your home stays happy.
      </div>
    </>
  );
}
