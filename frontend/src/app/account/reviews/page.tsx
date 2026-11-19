"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Star, Pencil, Trash2 } from "lucide-react";
import { AccountShell, PanelEmpty, PanelError, PanelLoading, Pager, inputClass, primaryButton, secondaryButton } from "@/components/AccountShell";
import { accountApi, ACCOUNT_PAGE_SIZE, type MyReview } from "@/lib/account-api";
import { formatIndianDate } from "@/lib/formatters";
import { useAsync } from "@/lib/useAsync";

const STATUS = {
  PENDING: { label: "Awaiting moderation", tone: "bg-amber-50 text-amber-800" },
  APPROVED: { label: "Published", tone: "bg-[#E0EFE5] text-[#116644]" },
  REJECTED: { label: "Not published", tone: "bg-red-50 text-red-700" },
} as const;

function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return (
    <div className="flex gap-0.5" role={onChange ? "radiogroup" : "img"} aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => onChange(n)}>
            <Star className={`h-5 w-5 ${n <= value ? "fill-amber-400 text-amber-400" : "text-[#D5DED8]"}`} />
          </button>
        ) : (
          <Star key={n} aria-hidden className={`h-4 w-4 ${n <= value ? "fill-amber-400 text-amber-400" : "text-[#D5DED8]"}`} />
        ),
      )}
    </div>
  );
}

export default function MyReviewsPage() {
  const [page, setPage] = useState(1);
  const { data, setData, error, loading, reload } = useAsync(() => accountApi.reviews(page), [page]);
  const [editing, setEditing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const replace = (r: MyReview) => setData((list) => (list ?? []).map((x) => (x.id === r.id ? { ...r, product: x.product } : x)));

  const remove = async (r: MyReview) => {
    if (!window.confirm(`Delete your review of ${r.product.name}?`)) return;
    setActionError(null);
    try {
      await accountApi.removeReview(r.id);
      setData((list) => (list ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not delete the review.");
    }
  };

  return (
    <AccountShell title="My reviews" subtitle="What you’ve said about our products." crumbs={[{ label: "My reviews" }]}>
      {actionError && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{actionError}</p>}
      {loading && !data ? (
        <PanelLoading label="Loading your reviews…" />
      ) : error ? (
        <PanelError message={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <PanelEmpty
          title={page === 1 ? "No reviews yet" : "No more reviews"}
          body="You can review any product you’ve bought from its product page."
          cta={page === 1 ? { label: "View my orders", href: "/account/orders" } : undefined}
        />
      ) : (
        <div className="space-y-4">
          <ul className="space-y-4">
            {data.map((r) => (
              <li key={r.id} className="rounded-3xl border border-[#E6EAE7] bg-white p-5 space-y-3 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/products/${r.product.slug}`} className="font-heading text-[16px] font-bold text-[#113322] hover:text-[#116644] break-words min-w-0">
                    {r.product.name}
                  </Link>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                </div>
                {editing === r.id ? (
                  <ReviewEditor review={r} onCancel={() => setEditing(null)} onSaved={(x) => { replace(x); setEditing(null); }} />
                ) : (
                  <>
                    <Stars value={r.rating} />
                    {r.title && <p className="text-[14px] font-semibold text-[#113322] break-words">{r.title}</p>}
                    <p className="text-[14px] text-[#4A5550] whitespace-pre-line break-words">{r.body}</p>
                    {r.moderationNote && <p className="text-[13px] text-red-700">Reason: {r.moderationNote}</p>}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12px] text-[#8A958E]">{formatIndianDate(r.updatedAt)}</span>
                      <div className="flex gap-2">
                        <button type="button" className={secondaryButton} onClick={() => setEditing(r.id)}><Pencil className="h-3.5 w-3.5" /> Edit</button>
                        <button type="button" className={secondaryButton} onClick={() => remove(r)} aria-label={`Delete review of ${r.product.name}`}><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          <Pager page={page} hasNext={data.length === ACCOUNT_PAGE_SIZE} onPage={setPage} />
        </div>
      )}
    </AccountShell>
  );
}

function ReviewEditor({ review, onCancel, onSaved }: { review: MyReview; onCancel: () => void; onSaved: (r: MyReview) => void }) {
  const [rating, setRating] = useState(review.rating);
  const [title, setTitle] = useState(review.title ?? "");
  const [body, setBody] = useState(review.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (body.trim().length < 10) return setError("Your review needs at least 10 characters.");
    setBusy(true);
    setError(null);
    try {
      onSaved(await accountApi.updateReview(review.id, { rating, title: title.trim() || null, body: body.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the review.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <Stars value={rating} onChange={setRating} />
      <input className={inputClass} placeholder="Title (optional)" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <textarea className={inputClass} rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Review" />
      <p className="text-[12px] text-[#8A958E]">Edited reviews are checked again before they show on the product page.</p>
      {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>{busy ? "Saving…" : "Save review"}</button>
        <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
