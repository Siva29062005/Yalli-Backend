'use client';

import { useState } from 'react';
import { Captcha, captchaRequired } from '@/components/Captcha';
import { ApiError, requestApi } from '@/lib/http';
import { fieldErrors } from '@/lib/auth-api';

const TOPICS = [
  ['ORDER', 'An order'],
  ['RETURN', 'A return or refund'],
  ['PAYMENT', 'A payment'],
  ['ACCOUNT', 'My account'],
  ['PRODUCT', 'A product'],
  ['OTHER', 'Something else'],
] as const;

const input =
  'w-full rounded-xl border border-[#D5DDD8] bg-white px-3.5 py-2.5 text-[14px] text-[#113322] outline-none focus:border-[#116644] focus:ring-2 focus:ring-[#116644]/15';

/** Contact form (POST /contact): plain text, rate-limited and captcha-checked by the server. */
export function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', orderNumber: '', topic: 'ORDER', message: '', website: '' });
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  if (sent)
    return (
      <p role="status" className="rounded-2xl border border-[#D5EAD9] bg-[#EEFFEE] p-5 text-[14px] text-[#116644]">
        Thanks, we have your message. We reply by email, usually within one working day.
      </p>
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrors({});
    if (form.message.trim().length < 10) return setErrors({ message: 'Please tell us a little more (at least 10 characters).' });
    if (captchaRequired && !captchaToken) return setError('Please complete the security check.');
    setBusy(true);
    try {
      await requestApi<null>('/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          topic: form.topic,
          message: form.message.trim(),
          ...(form.orderNumber.trim() ? { orderNumber: form.orderNumber.trim().toUpperCase() } : {}),
          ...(form.website ? { website: form.website } : {}),
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });
      setSent(true);
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(f);
      setError(Object.keys(f).length ? 'Please fix the highlighted fields.' : err instanceof ApiError ? err.message : 'Could not send your message. Please try again.');
    } finally {
      setBusy(false);
      setCaptchaRound((n) => n + 1);
    }
  };

  const fieldError = (k: string) =>
    errors[k] ? (
      <span id={`${k}-error`} className="block text-[12px] text-red-600">
        {errors[k]}
      </span>
    ) : null;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-[#E6EAE7] bg-white p-5" noValidate aria-labelledby="contact-form-h">
      <h3 id="contact-form-h" className="font-heading text-[17px] font-bold text-[#113322]">Send us a message</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">Your name</span>
          <input className={input} value={form.name} onChange={set('name')} maxLength={100} autoComplete="name" required aria-describedby="name-error" />
          {fieldError('name')}
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">Email (we reply here)</span>
          <input className={input} type="email" value={form.email} onChange={set('email')} maxLength={254} autoComplete="email" required aria-describedby="email-error" />
          {fieldError('email')}
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">About</span>
          <select className={input} value={form.topic} onChange={set('topic')}>
            {TOPICS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">Order number (optional)</span>
          <input className={input} value={form.orderNumber} onChange={set('orderNumber')} maxLength={20} placeholder="e.g. YL26-1001" aria-describedby="orderNumber-error" />
          {fieldError('orderNumber')}
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium text-[#4A5550]">Message</span>
        <textarea className={`${input} min-h-[140px]`} value={form.message} onChange={set('message')} maxLength={2000} required aria-describedby="message-error" />
        {fieldError('message')}
      </label>
      {/* Hidden from people (and screen readers); bots fill it in and are dropped by the server. */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
        </label>
      </div>
      <p className="text-[12px] text-[#5F6B64]">Never send card numbers, passwords or one-time codes. We will never ask for them.</p>
      <Captcha action="contact" onToken={setCaptchaToken} resetKey={captchaRound} />
      {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-xl bg-[#116644] px-6 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50">
        {busy ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}
