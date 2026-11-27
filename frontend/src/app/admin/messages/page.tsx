'use client';

import { useState } from 'react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Pager, Pill, adminButton, adminCard, adminGhostButton, useClampedPage } from '@/components/AdminKit';
import { adminList, adminPost } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatDateTime } from '@/lib/formatters';

interface ContactMessage {
  id: string;
  name: string;
  email: string;
  orderNumber: string | null;
  topic: 'ORDER' | 'RETURN' | 'PAYMENT' | 'ACCOUNT' | 'PRODUCT' | 'OTHER';
  message: string;
  status: 'NEW' | 'HANDLED';
  createdAt: string;
  handledAt: string | null;
}

const TOPIC: Record<ContactMessage['topic'], string> = { ORDER: 'An order', RETURN: 'A return or refund', PAYMENT: 'A payment', ACCOUNT: 'My account', PRODUCT: 'A product', OTHER: 'Something else' };

/**
 * Contact-form messages (customers.read). The sender's details are NOT verified: before sharing order details, check
 * that the email is the one on that order (Customers screen). Messages are plain text.
 */
export default function AdminMessagesPage() {
  const { withStepUp } = useAdminSession();
  const [status, setStatus] = useState<'NEW' | 'HANDLED'>('NEW');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const list = useAdminQuery(() => adminList<ContactMessage>('/admin/contact-messages', { status, page, pageSize: 20 }), [status, page]);
  useClampedPage(list.data?.meta, page, setPage);
  const rows = list.data?.items ?? [];

  async function handled(id: string) {
    setBusyId(id);
    setError('');
    try {
      await withStepUp(() => adminPost(`/admin/contact-messages/${id}/handled`));
      list.reload();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not update the message.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminPage eyebrow="Support" title="Messages" subtitle="Questions sent with the contact form. Reply by email, then mark the message as handled.">
      <Alert kind="warning">The name, email and order number were typed by the sender and are not verified. Before sharing order or delivery details, check that the email is the one on that order.</Alert>
      {error && <Alert kind="error">{error}</Alert>}
      <div role="tablist" aria-label="Message status" className="flex gap-2">
        {(['NEW', 'HANDLED'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={status === s ? adminButton : adminGhostButton} onClick={() => { setPage(1); setStatus(s); }}>
            {s === 'NEW' ? 'To answer' : 'Handled'}
          </button>
        ))}
      </div>
      <section className={`${adminCard} min-w-0`}>
        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle={status === 'NEW' ? 'No new messages' : 'Nothing handled yet'}>
          <ul className="divide-y divide-[#E6EAE7]">
            {rows.map((m) => (
              <li key={m.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-semibold">{m.name} · <a className="text-[#116644] underline" href={`mailto:${encodeURIComponent(m.email).replace('%40', '@')}`}>{m.email}</a></p>
                    <p className="text-xs text-[#4A5550]">{TOPIC[m.topic]}{m.orderNumber ? ` · order ${m.orderNumber}` : ''} · {formatDateTime(m.createdAt)}</p>
                  </div>
                  <Pill tone={m.status === 'NEW' ? 'amber' : 'green'}>{m.status === 'NEW' ? 'To answer' : `Handled ${m.handledAt ? formatDateTime(m.handledAt) : ''}`}</Pill>
                </div>
                {/* plain text (React escapes it) */}
                <p className="whitespace-pre-wrap break-words text-sm">{m.message}</p>
                {m.status === 'NEW' && (
                  <button className={adminGhostButton} disabled={busyId === m.id} onClick={() => void handled(m.id)}>Mark as handled</button>
                )}
              </li>
            ))}
          </ul>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>
    </AdminPage>
  );
}
