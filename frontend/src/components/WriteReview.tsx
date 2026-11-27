'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Star, Loader2 } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { customerSession } from '@/lib/customer-session';
import { ApiError } from '@/lib/http';

const input =
  'w-full min-w-0 rounded-xl border border-[#E6EAE7] bg-white px-3.5 py-2.5 text-[14px] text-[#113322] outline-none focus:border-[#116644] focus:ring-2 focus:ring-[#116644]/15';

/**
 * "Write a review" for the product page. The backend decides eligibility (only customers who
 * received the product, one review each); its message is shown when it refuses.
 */
export function WriteReview({ slug }: { slug: string }) {
  const { status } = useAuth();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<{ rating?: string; body?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (status !== 'authenticated') {
    return (
      <p className="text-[13px] text-[#4A5550]">
        Bought this product?{' '}
        <Link
          href={`/auth/login?next=${encodeURIComponent(`/products/${slug}#reviews`)}`}
          className="font-semibold text-[#116644] hover:underline"
        >
          Sign in to write a review
        </Link>
      </p>
    );
  }
  if (done) {
    return (
      <p role="status" className="rounded-xl bg-[#EEFFEE] px-4 py-3 text-[13px] text-[#116644]">
        {done}
      </p>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-[#116644] px-4 py-2 text-[13px] font-semibold text-[#116644] hover:bg-[#116644] hover:text-white"
      >
        Write a review
      </button>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (rating < 1) errs.rating = 'Choose a star rating.';
    if (body.trim().length < 10) errs.body = 'Write at least 10 characters.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSending(true);
    setFormError(null);
    try {
      await customerSession.request(`/catalog/products/${encodeURIComponent(slug)}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ rating, title: title.trim() || null, body: body.trim() }),
      });
      setDone('Thanks! Your review will appear once it has been checked. You can edit it from My Reviews.');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not submit your review. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const shown = hover || rating;
  return (
    <form onSubmit={submit} noValidate aria-label="Write a review" className="space-y-4 rounded-xl border border-[#E6EAE7] bg-[#FAFAFA] p-4">
      <fieldset>
        <legend className="mb-1 text-[13px] font-medium text-[#113322]">Your rating</legend>
        <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((i) => (
            <button
              key={i}
              type="button"
              aria-label={`${i} star${i > 1 ? 's' : ''}`}
              aria-pressed={rating === i}
              onMouseEnter={() => setHover(i)}
              onClick={() => setRating(i)}
              className="p-0.5"
            >
              <Star className={`h-6 w-6 ${i <= shown ? 'fill-[#FF9900] text-[#FF9900]' : 'text-[#C9D1CC]'}`} />
            </button>
          ))}
        </div>
        {errors.rating && <p className="mt-1 text-[12px] text-[#B42318]">{errors.rating}</p>}
      </fieldset>
      <div>
        <label htmlFor="review-title" className="mb-1 block text-[13px] font-medium text-[#113322]">Title (optional)</label>
        <input id="review-title" className={input} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor="review-body" className="mb-1 block text-[13px] font-medium text-[#113322]">Your review</label>
        <textarea
          id="review-body"
          rows={4}
          maxLength={2000}
          className={input}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={!!errors.body}
        />
        <div className="mt-1 flex justify-between text-[12px]">
          <span className="text-[#B42318]">{errors.body}</span>
          <span className="text-[#5F6B64]">{body.length}/2000</span>
        </div>
      </div>
      {formError && <p role="alert" className="text-[13px] text-[#B42318]">{formError}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={sending} className="inline-flex items-center gap-2 rounded-xl bg-[#116644] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#0e5237] disabled:opacity-60">
          {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Submit review
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-xl px-4 py-2 text-[13px] font-semibold text-[#5F6B64] hover:text-[#113322]">
          Cancel
        </button>
      </div>
    </form>
  );
}
