'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useUrlToken } from '@/lib/url-token';
import { CheckCircle2, Loader2, Mail, XCircle } from 'lucide-react';
import { AuthNarrowShell, FormAlert, inputClass } from '@/components/AuthShell';
import { errorMessage, resendVerification, verifyEmail } from '@/lib/auth-api';

function VerifyEmail() {
  const token = useUrlToken();
  const [state, setState] = useState<'idle' | 'verifying' | 'done' | 'failed'>(token ? 'verifying' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // Tokens are single-use; guard against React strict-mode double effects.
    if (!token || started.current) return;
    started.current = true;
    verifyEmail(token)
      .then(() => setState('done'))
      .catch((err) => {
        setError(errorMessage(err, 'This link could not be verified.'));
        setState('failed');
      });
  }, [token]);

  if (state === 'verifying') {
    return (
      <div className="space-y-4" role="status">
        <Loader2 className="w-10 h-10 text-[#116644] animate-spin mx-auto" aria-hidden />
        <h1 className="font-heading text-[28px] font-bold text-[#113322]">Verifying your email…</h1>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div className="space-y-5">
        <CheckCircle2 className="w-16 h-16 text-[#116644] mx-auto" aria-hidden />
        <h1 className="font-heading text-[30px] font-bold text-[#113322]">You&apos;re all set!</h1>
        <p className="text-[15px] text-[#4A5550]">Your email is verified. Log in to start shopping.</p>
        <Link
          href="/auth/login?verified=1"
          className="inline-block bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-bold text-[15px] px-8 py-3 rounded-xl transition"
        >
          Log in →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="w-20 h-20 bg-[#EEFFEE] text-[#116644] rounded-full flex items-center justify-center mx-auto border border-[#D5EAD9]">
        {state === 'failed' ? <XCircle className="w-10 h-10 text-red-600" /> : <Mail className="w-10 h-10" />}
      </div>
      <div className="space-y-2">
        <h1 className="font-heading text-[30px] font-bold text-[#113322]">
          {state === 'failed' ? 'This link has expired' : 'Check your inbox'}
        </h1>
        <p className="text-[15px] text-[#4A5550] leading-relaxed">
          {state === 'failed'
            ? 'Verification links work once and expire after a while. Request a new one below.'
            : 'We sent a verification link to your email. Open it to activate your account.'}
        </p>
      </div>
      {error && <FormAlert>{error}</FormAlert>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await resendVerification(email.trim()).catch(() => undefined);
          setResent(true);
        }}
        className="bg-white rounded-3xl p-6 border border-[#E6EAE7] space-y-3 text-left"
      >
        {resent ? (
          <FormAlert tone="success">If that account needs verification, a new email is on its way.</FormAlert>
        ) : (
          <>
            <label htmlFor="resend-email" className="text-[12px] font-semibold text-[#113322]">
              Send a new link to
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="resend-email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${inputClass} min-w-0`}
              />
              <button
                type="submit"
                className="shrink-0 border border-[#116644] text-[#116644] hover:bg-[#EEFFEE] text-[13px] font-semibold px-5 py-2.5 rounded-xl transition"
              >
                Resend link
              </button>
            </div>
          </>
        )}
      </form>
      <Link href="/auth/login" className="text-[14px] text-[#116644] font-semibold hover:underline">
        ← Back to Login
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthNarrowShell>
      <Suspense>
        <VerifyEmail />
      </Suspense>
    </AuthNarrowShell>
  );
}
