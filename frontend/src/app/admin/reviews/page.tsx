'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminList, adminPost } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatDateTime } from '@/lib/formatters';

type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
interface ReviewRow {
  id: string;
  product: { slug: string; name: string };
  /** Already masked by the API (first name and last initial). */
  reviewer: string;
  rating: number;
  title: string | null;
  body: string;
  status: ReviewStatus;
  moderationNote: string | null;
  createdAt: string;
}

const STATUS_TONE = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'gray' } as const;
const STATUS_LABEL = { PENDING: 'Waiting', APPROVED: 'Published', REJECTED: 'Rejected' } as const;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function AdminReviewsPage() {
  const { withStepUp } = useAdminSession();
  const [status, setStatus] = useState<ReviewStatus>('PENDING');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const list = useAdminQuery(() => adminList<ReviewRow>('/admin/reviews', { status, page, pageSize: 20 }), [status, page]);
  const rows = list.data?.items ?? [];

  async function decide(id: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await withStepUp(() => adminPost(`/admin/reviews/${id}/decision`, { decision, ...(note ? { note } : {}) }));
      setNotice(decision === 'APPROVED' ? 'Review published on the product page.' : 'Review rejected. The customer sees your reason.');
      setRejecting(null);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminPage
      eyebrow="Catalogue"
      title="Reviews"
      subtitle="Only customers who received the product can review it. Nothing is shown publicly until you approve it; edits go back to the queue."
    >
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <div role="tablist" aria-label="Review status" className="flex flex-wrap gap-2">
        {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={status === s}
            className={status === s ? adminButton : adminGhostButton}
            onClick={() => {
              setPage(1);
              setStatus(s);
              setRejecting(null);
            }}
          >
            {s === 'PENDING' ? 'Waiting for review' : s === 'APPROVED' ? 'Published' : 'Rejected'}
          </button>
        ))}
      </div>

      <section className={`${adminCard} min-w-0`}>
        <DataState
          loading={list.loading && !list.data}
          error={list.error}
          empty={rows.length === 0}
          emptyTitle={status === 'PENDING' ? 'Nothing is waiting' : 'No reviews here'}
          emptyHint={status === 'PENDING' ? 'New reviews appear here, oldest first.' : undefined}
        >
          <ul className="divide-y divide-[#E6EAE7]">
            {rows.map((r) => (
              <li key={r.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      <span role="img" aria-label={`${r.rating} out of 5 stars`} className="mr-2 tracking-wider text-[#FF9900]">
                        {'★'.repeat(r.rating)}
                        <span className="text-[#DCE3DE]">{'★'.repeat(5 - r.rating)}</span>
                      </span>
                      <Link href={`/products/${r.product.slug}`} target="_blank" rel="noopener" className="break-words text-[#116644] underline">
                        {r.product.name}
                      </Link>
                    </p>
                    <p className="text-xs text-[#4A5550]">{r.reviewer} · {formatDateTime(r.createdAt)}</p>
                  </div>
                  <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
                </div>
                {r.title && <p className="break-words font-semibold">{r.title}</p>}
                {/* Plain text only: React escapes it, and the API stores it as text. */}
                <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p>
                {r.moderationNote && <p className="text-xs text-[#4A5550]">Moderator note: {r.moderationNote}</p>}

                {r.status === 'PENDING' &&
                  (rejecting?.id === r.id ? (
                    <form
                      className="flex flex-wrap items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void decide(r.id, 'REJECTED', rejecting.note.trim());
                      }}
                    >
                      <Field label="Reason (shown to the customer)">
                        <input required minLength={3} maxLength={300} className={adminInput} value={rejecting.note} onChange={(e) => setRejecting({ id: r.id, note: e.target.value })} />
                      </Field>
                      <button className={adminDangerButton} disabled={busyId === r.id}>Reject review</button>
                      <button type="button" className={adminGhostButton} onClick={() => setRejecting(null)}>Cancel</button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button className={adminButton} disabled={busyId === r.id} onClick={() => void decide(r.id, 'APPROVED')}>Approve</button>
                      <button className={adminGhostButton} disabled={busyId === r.id} onClick={() => setRejecting({ id: r.id, note: '' })}>Reject…</button>
                    </div>
                  ))}
              </li>
            ))}
          </ul>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>
    </AdminPage>
  );
}
