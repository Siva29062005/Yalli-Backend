'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useUrlToken } from '@/lib/url-token';
import { Captcha, captchaRequired } from '@/components/Captcha';
import { Check, Lock } from 'lucide-react';
import { AuthNarrowShell, FieldError, FormAlert, inputClass } from '@/components/AuthShell';
import { errorMessage, fieldErrors, forgotPassword, passwordProblems, resetPassword } from '@/lib/auth-api';

const buttonClass =
  'w-full bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-bold text-[14px] py-3 rounded-xl transition shadow-xs cursor-pointer disabled:opacity-60';

function RequestLink() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="bg-white rounded-3xl p-8 border border-[#E6EAE7] space-y-3">
        <div className="w-10 h-10 rounded-full bg-[#EEFFEE] text-[#116644] flex items-center justify-center mx-auto">
          <Check className="w-5 h-5 stroke-[3]" />
        </div>
        <h2 className="font-heading text-lg font-bold text-[#113322]">Check your inbox</h2>
        <p className="text-[13px] text-[#4A5550] break-words">
          If an account exists for {email.trim()}, you will receive a password reset link shortly.
        </p>
        <Link href="/auth/login" className="inline-block pt-2 text-[13px] text-[#116644] font-semibold hover:underline">
          Back to Login
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (captchaRequired && !captchaToken) {
          setError('Please complete the security check.');
          return;
        }
        setBusy(true);
        try {
          await forgotPassword(email.trim(), captchaToken ?? undefined);
          setSent(true);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
          setCaptchaRound((n) => n + 1); // single-use token
        }
      }}
      className="bg-white rounded-3xl p-6 sm:p-8 border border-[#E6EAE7] space-y-4 text-left shadow-xs"
    >
      {error && <FormAlert>{error}</FormAlert>}
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-[12px] font-semibold text-[#113322]">Email address</label>
        <input id="email" type="email" required autoComplete="email" maxLength={254} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
      </div>
      <Captcha action="forgot_password" onToken={setCaptchaToken} resetKey={captchaRound} />
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
      <div className="text-center pt-2">
        <Link href="/auth/login" className="text-[13px] text-[#8A958E] hover:text-[#116644]">
          Remembered your password? Log in
        </Link>
      </div>
    </form>
  );
}

function ChooseNewPassword({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const problem = passwordProblems(password)[0] ?? (password !== confirm ? 'The passwords do not match' : undefined);
        setFieldError(problem);
        if (problem) return;
        setBusy(true);
        try {
          await resetPassword(token, password);
          router.replace('/auth/login?reset=1');
        } catch (err) {
          const fields = fieldErrors(err);
          if (fields.newPassword) setFieldError(fields.newPassword.replace(/^/, 'Password '));
          else setError(errorMessage(err, 'This reset link is invalid or has expired.'));
        } finally {
          setBusy(false);
        }
      }}
      className="bg-white rounded-3xl p-6 sm:p-8 border border-[#E6EAE7] space-y-4 text-left shadow-xs"
    >
      {error && (
        <FormAlert>
          {error}{' '}
          <Link href="/auth/reset-password" className="font-semibold underline">Request a new link</Link>
        </FormAlert>
      )}
      <div className="space-y-1.5">
        <label htmlFor="new-password" className="text-[12px] font-semibold text-[#113322]">New password</label>
        <div className="relative">
          <input
            id="new-password"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            maxLength={128}
            placeholder="At least 12 characters"
            value={password}
            aria-invalid={fieldError ? true : undefined}
            onChange={(e) => setPassword(e.target.value)}
            className={`${inputClass} pr-16`}
          />
          <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[#8A958E] hover:text-[#113322]">
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="confirm-password" className="text-[12px] font-semibold text-[#113322]">Confirm new password</label>
        <input id="confirm-password" type={show ? 'text' : 'password'} autoComplete="new-password" maxLength={128} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} />
        <FieldError id="password-error" message={fieldError} />
      </div>
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? 'Saving…' : 'Update password'}
      </button>
      <p className="text-[12px] text-[#8A958E] text-center">You&apos;ll be signed out of other devices.</p>
    </form>
  );
}

function ResetPassword() {
  const token = useUrlToken();
  return (
    <>
      <div className="w-16 h-16 bg-[#EEFFEE] text-[#116644] rounded-full flex items-center justify-center mx-auto border border-[#D5EAD9]">
        <Lock className="w-8 h-8" />
      </div>
      <div className="space-y-1">
        <h1 className="font-heading text-[30px] font-bold text-[#113322]">
          {token ? 'Choose a new password' : 'Reset your password'}
        </h1>
        <p className="text-[14px] text-[#8A958E]">
          {token
            ? 'Pick something long and memorable that you don’t use elsewhere.'
            : 'Enter your email and we’ll send you a link to create a new password.'}
        </p>
      </div>
      {token ? <ChooseNewPassword token={token} /> : <RequestLink />}
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthNarrowShell>
      <Suspense>
        <ResetPassword />
      </Suspense>
    </AuthNarrowShell>
  );
}
