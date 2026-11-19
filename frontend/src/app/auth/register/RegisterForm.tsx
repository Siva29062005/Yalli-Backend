'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FieldError, FormAlert, inputClass, primaryButtonClass } from '@/components/AuthShell';
import { errorMessage, fieldErrors, passwordProblems, registerAccount, resendVerification } from '@/lib/auth-api';

type Field = 'firstName' | 'lastName' | 'email' | 'phone' | 'password' | 'acceptPrivacyPolicy';

export function RegisterForm() {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [newsletter, setNewsletter] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((er) => ({ ...er, [key]: undefined }));
  };

  const validate = () => {
    const out: Partial<Record<Field, string>> = {};
    if (!form.firstName.trim()) out.firstName = 'Enter your first name';
    if (!form.lastName.trim()) out.lastName = 'Enter your last name';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) out.email = 'Enter a valid email address';
    const digits = form.phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) out.phone = 'Enter a valid mobile number';
    const pw = passwordProblems(form.password, form);
    if (pw.length) out.password = pw[0];
    if (!accepted) out.acceptPrivacyPolicy = 'Please accept the Privacy Policy to continue';
    return out;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) {
      document.getElementById(Object.keys(found)[0])?.focus();
      return;
    }
    setBusy(true);
    try {
      await registerAccount({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        password: form.password,
        newsletter,
        acceptPrivacyPolicy: true,
      });
      setDone(true);
      setForm((f) => ({ ...f, password: '' }));
    } catch (err) {
      const fields = fieldErrors(err) as Partial<Record<Field, string>>;
      setErrors(fields);
      setFormError(Object.keys(fields).length ? 'Please fix the highlighted fields.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-5 text-center sm:text-left">
        <span className="text-[11px] font-bold text-[#116644] tracking-wider uppercase">Almost there</span>
        <h1 className="font-heading text-[28px] sm:text-[32px] font-bold text-[#113322]">Check your inbox.</h1>
        <p className="text-[14px] text-[#4A5550] leading-relaxed">
          We sent a verification link to <strong className="break-all">{form.email.trim()}</strong>. Open it to
          activate your account, then log in.
        </p>
        <p className="text-[13px] text-[#8A958E]">Didn&apos;t get it? Check your spam folder or request a new link.</p>
        {resent ? (
          <FormAlert tone="success">If the account needs verification, a new email is on its way.</FormAlert>
        ) : (
          <button
            type="button"
            onClick={async () => {
              await resendVerification(form.email.trim()).catch(() => undefined);
              setResent(true);
            }}
            className="border border-[#116644] text-[#116644] hover:bg-[#EEFFEE] text-[13px] font-semibold px-5 py-2.5 rounded-xl transition"
          >
            Resend verification email
          </button>
        )}
        <div>
          <Link href="/auth/login" className="text-[13px] text-[#116644] font-semibold hover:underline">
            Go to log in →
          </Link>
        </div>
      </div>
    );
  }

  const field = (key: Field) => ({
    id: key,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${key}-error` : undefined,
  });

  return (
    <>
      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[#116644] tracking-wider uppercase">Make yourself at home</span>
        <h1 className="font-heading text-[28px] sm:text-[32px] font-bold text-[#113322]">A good place to start.</h1>
        <p className="text-[14px] text-[#8A958E]">Create your Yalli account. It only takes a moment.</p>
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        {formError && <FormAlert>{formError}</FormAlert>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5 min-w-0">
            <label htmlFor="firstName" className="text-[12px] font-semibold text-[#113322]">First name</label>
            <input {...field('firstName')} autoComplete="given-name" maxLength={60} value={form.firstName} onChange={set('firstName')} className={inputClass} />
            <FieldError id="firstName-error" message={errors.firstName} />
          </div>
          <div className="space-y-1.5 min-w-0">
            <label htmlFor="lastName" className="text-[12px] font-semibold text-[#113322]">Last name</label>
            <input {...field('lastName')} autoComplete="family-name" maxLength={60} value={form.lastName} onChange={set('lastName')} className={inputClass} />
            <FieldError id="lastName-error" message={errors.lastName} />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-[12px] font-semibold text-[#113322]">Email address</label>
          <input {...field('email')} type="email" autoComplete="email" maxLength={254} placeholder="you@example.com" value={form.email} onChange={set('email')} className={inputClass} />
          <FieldError id="email-error" message={errors.email} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="phone" className="text-[12px] font-semibold text-[#113322]">Mobile number</label>
          <input {...field('phone')} type="tel" autoComplete="tel" maxLength={20} placeholder="98765 43210" value={form.phone} onChange={set('phone')} className={inputClass} />
          <FieldError id="phone-error" message={errors.phone} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-[12px] font-semibold text-[#113322]">Password</label>
          <div className="relative">
            <input
              {...field('password')}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              maxLength={128}
              placeholder="At least 12 characters"
              value={form.password}
              onChange={set('password')}
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
          {errors.password ? (
            <FieldError id="password-error" message={errors.password} />
          ) : (
            <p className="text-[12px] text-[#8A958E]">A long phrase is easy to remember and hard to guess.</p>
          )}
        </div>
        <label className="flex items-start gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" checked={newsletter} onChange={(e) => setNewsletter(e.target.checked)} className="mt-1 rounded text-[#116644]" />
          <span className="text-[#4A5550]">Send me offers and new arrivals (optional).</span>
        </label>
        <div className="space-y-1">
          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <input
              {...field('acceptPrivacyPolicy')}
              type="checkbox"
              checked={accepted}
              onChange={(e) => {
                setAccepted(e.target.checked);
                setErrors((er) => ({ ...er, acceptPrivacyPolicy: undefined }));
              }}
              className="mt-1 rounded text-[#116644]"
            />
            <span className="text-[#4A5550]">I accept the Privacy Policy and Terms of Service.</span>
          </label>
          <FieldError id="acceptPrivacyPolicy-error" message={errors.acceptPrivacyPolicy} />
        </div>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? 'Creating your account…' : 'Create account →'}
        </button>
      </form>

      <div className="text-center pt-2">
        <Link href="/auth/login" className="text-[13px] text-[#116644] font-semibold hover:underline">
          Already at home here? Log in →
        </Link>
      </div>
    </>
  );
}
