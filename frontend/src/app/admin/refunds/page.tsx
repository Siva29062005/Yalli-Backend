'use client';

import { useRef, useState } from 'react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminList, adminPost, newIdempotencyKey, rupeesToPaise } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { RETURN_REASONS, type ReturnReason } from '@/lib/account-api';
import { formatDateTime, formatPaise } from '@/lib/formatters';

type RefundStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'REJECTED';
interface RefundRow {
  id: string;
  orderId: string;
  order: { orderNumber: string };
  kind: string;
  amountMinor: number;
  status: RefundStatus;
  reason: string;
  requestedById: string | null;
  approvedById: string | null;
  createdAt: string;
  processedAt: string | null;
  failureReason: string | null;
}
interface ReturnRow {
  id: string;
  quantity: number;
  reason: ReturnReason;
  opened: boolean;
  details: string | null;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'RECEIVED' | 'REFUNDED';
  decisionNote: string | null;
  createdAt: string;
  order: { orderNumber: string };
  item: { productName: string; sku: string };
}
interface OrderMatch {
  id: string;
  orderNumber: string;
  totalMinor: number;
  contactEmail: string;
}

const REFUND_TONE = { PENDING_APPROVAL: 'amber', APPROVED: 'blue', PROCESSING: 'blue', PROCESSED: 'green', FAILED: 'red', REJECTED: 'gray' } as const;
const REFUND_LABEL: Record<RefundStatus, string> = {
  PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved',
  PROCESSING: 'Processing',
  PROCESSED: 'Refunded',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
};
const RETURN_TONE = { REQUESTED: 'amber', APPROVED: 'blue', REJECTED: 'gray', RECEIVED: 'blue', REFUNDED: 'green' } as const;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function AdminRefundsPage() {
  const { can } = useAdminSession();
  // Finance sees the refund list; support can request refunds without listing them; order staff see returns.
  const tabs = (['refunds', 'returns'] as const).filter((t) => (t === 'refunds' ? can('payments.read') || can('refunds.create') : can('orders.read')));
  const [chosen, setChosen] = useState<'refunds' | 'returns'>('refunds');
  const tab = tabs.includes(chosen) ? chosen : (tabs[0] ?? 'refunds');
  return (
    <AdminPage eyebrow="Finance" title="Refunds & returns" subtitle="Money moves only after a second person approves it. Returns are checked before any refund is raised.">
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Refunds and returns" className="flex gap-2">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setChosen(t)} className={tab === t ? adminButton : adminGhostButton}>
              {t === 'refunds' ? 'Refunds' : 'Return requests'}
            </button>
          ))}
        </div>
      )}
      {tab === 'refunds' ? <RefundsTab /> : <ReturnsTab />}
    </AdminPage>
  );
}

// ------------------------------------------------------------------------------------------------ refunds

function RefundsTab() {
  const { withStepUp, identity, can } = useAdminSession();
  const canList = can('payments.read');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const list = useAdminQuery(
    () => (canList ? adminList<RefundRow>('/admin/refunds', { status, page, pageSize: 20 }) : Promise.resolve({ items: [] as RefundRow[], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } })),
    [status, page, canList],
  );
  const rows = list.data?.items ?? [];

  async function decide(id: string, action: 'approve' | 'reject', reason?: string) {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await withStepUp(() => adminPost(`/admin/refunds/${id}/${action}`, action === 'reject' ? { reason } : {}));
      setNotice(action === 'approve' ? 'Refund approved. It is being sent to the customer.' : 'Refund request rejected.');
      setRejecting(null);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <section className={`${adminCard} min-w-0`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E6EAE7] p-4">
          {canList ? (
            <select aria-label="Filter by status" className="rounded-xl border border-[#DCE3DE] bg-white p-2 text-sm" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All refunds</option>
              {(Object.keys(REFUND_LABEL) as RefundStatus[]).map((s) => <option key={s} value={s}>{REFUND_LABEL[s]}</option>)}
            </select>
          ) : (
            <p className="text-sm text-[#4A5550]">You can request a refund here. A finance manager approves it and sees the full list.</p>
          )}
          {can('refunds.create') && <button className={adminButton} onClick={() => setCreating((c) => !c)}>{creating ? 'Close form' : 'Request a refund'}</button>}
        </div>
        {creating && (
          <CreateRefund
            onDone={() => {
              setCreating(false);
              setNotice('Refund requested. A second person must approve it before any money moves.');
              list.reload();
            }}
          />
        )}
        {canList && <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No refunds" emptyHint={status ? 'No refunds with this status.' : 'Refund requests will show up here.'}>
          <ul className="divide-y divide-[#E6EAE7]">
            {rows.map((r) => (
              <li key={r.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{r.order.orderNumber} · {formatPaise(r.amountMinor)}</p>
                    <p className="break-words text-sm text-[#4A5550]">{r.reason}</p>
                    <p className="text-xs text-[#4A5550]">{r.kind.toLowerCase().replaceAll('_', ' ')} · requested {formatDateTime(r.createdAt)}{r.processedAt ? ` · refunded ${formatDateTime(r.processedAt)}` : ''}</p>
                    {r.failureReason && <p className="text-xs text-red-700">{r.failureReason}</p>}
                  </div>
                  <Pill tone={REFUND_TONE[r.status]}>{REFUND_LABEL[r.status]}</Pill>
                </div>
                {r.status === 'PENDING_APPROVAL' && (
                  rejecting?.id === r.id ? (
                    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void decide(r.id, 'reject', rejecting.reason.trim()); }}>
                      <Field label="Reason for rejecting">
                        <input required minLength={3} maxLength={200} className={adminInput} value={rejecting.reason} onChange={(e) => setRejecting({ id: r.id, reason: e.target.value })} />
                      </Field>
                      <button className={adminDangerButton} disabled={busyId === r.id}>Reject refund</button>
                      <button type="button" className={adminGhostButton} onClick={() => setRejecting(null)}>Cancel</button>
                    </form>
                  ) : (
                    can('refunds.approve') && <div className="flex flex-wrap gap-2">
                      {/* The server also refuses self-approval; hiding the button just avoids a pointless error. */}
                      {r.requestedById !== null && r.requestedById === identity.id ? (
                        <p className="text-xs text-[#4A5550]">You requested this refund, so another person must approve it.</p>
                      ) : (
                        <button className={adminButton} disabled={busyId === r.id} onClick={() => { if (window.confirm(`Approve a refund of ${formatPaise(r.amountMinor)} for ${r.order.orderNumber}? Money is sent to the customer.`)) void decide(r.id, 'approve'); }}>Approve</button>
                      )}
                      <button className={adminGhostButton} disabled={busyId === r.id} onClick={() => setRejecting({ id: r.id, reason: '' })}>Reject…</button>
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>}
      </section>
    </>
  );
}

function CreateRefund({ onDone }: { onDone: () => void }) {
  const { withStepUp } = useAdminSession();
  const [orderQuery, setOrderQuery] = useState('');
  const [matches, setMatches] = useState<OrderMatch[] | null>(null);
  const [order, setOrder] = useState<OrderMatch | null>(null);
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'ADMIN' | 'GOODWILL'>('ADMIN');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One key per distinct request: a retry after a network error is not applied twice.
  const keys = useRef(new Map<string, string>());

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setMatches((await withStepUp(() => adminList<OrderMatch>('/admin/orders', { q: orderQuery.trim(), pageSize: 5 }))).items);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!order) return;
    const amountMinor = rupeesToPaise(amount);
    if (amountMinor === null || amountMinor < 1) return setError('Enter the refund amount in rupees, e.g. 250 or 250.50.');
    if (amountMinor > order.totalMinor) return setError(`The refund cannot be more than the order total (${formatPaise(order.totalMinor)}).`);
    const body = { orderId: order.id, amountMinor, kind, reason: reason.trim() };
    const sig = JSON.stringify(body);
    const key = keys.current.get(sig) ?? newIdempotencyKey();
    keys.current.set(sig, key);
    setBusy(true);
    setError('');
    try {
      await withStepUp(() => adminPost('/admin/refunds', body, { 'Idempotency-Key': key }));
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-b border-[#E6EAE7] bg-[#F7F9F8] p-4">
      {error && <Alert kind="error">{error}</Alert>}
      {!order ? (
        <form onSubmit={search} className="flex flex-wrap items-end gap-3">
          <Field label="Find the order">
            <input required maxLength={100} placeholder="Order number or email" className={adminInput} value={orderQuery} onChange={(e) => setOrderQuery(e.target.value)} />
          </Field>
          <button className={adminGhostButton} disabled={busy}>Search</button>
          {matches && (
            <ul className="w-full space-y-2">
              {matches.length === 0 && <li className="text-sm text-[#4A5550]">No matching orders.</li>}
              {matches.map((m) => (
                <li key={m.id}>
                  <button type="button" className="w-full rounded-xl border border-[#DCE3DE] bg-white p-3 text-left text-sm hover:border-[#116644]" onClick={() => setOrder(m)}>
                    <strong>{m.orderNumber}</strong> · {formatPaise(m.totalMinor)} · {m.contactEmail}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm sm:col-span-2">Order <strong>{order.orderNumber}</strong> · total {formatPaise(order.totalMinor)} <button type="button" className="ml-2 underline" onClick={() => setOrder(null)}>Change</button></p>
          <Field label="Amount to refund (₹)">
            <input required inputMode="decimal" className={adminInput} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Type">
            <select className={adminInput} value={kind} onChange={(e) => setKind(e.target.value as 'ADMIN' | 'GOODWILL')}>
              <option value="ADMIN">Correction</option>
              <option value="GOODWILL">Goodwill gesture</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason" hint="5 to 200 characters. Kept in the audit trail.">
              <input required minLength={5} maxLength={200} className={adminInput} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2"><button className={adminButton} disabled={busy}>{busy ? 'Requesting…' : 'Request refund'}</button></div>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ returns

function ReturnsTab() {
  const { withStepUp, can } = useAdminSession();
  const canDecide = can('orders.update');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const list = useAdminQuery(() => adminList<ReturnRow>('/admin/returns', { page, pageSize: 20 }), [page]);
  const rows = list.data?.items ?? [];

  async function act(id: string, message: string, call: () => Promise<unknown>) {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await withStepUp(call);
      setNotice(message);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <section className={`${adminCard} min-w-0`}>
        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No return requests" emptyHint="Customers can request a return within 7 days of delivery.">
          <ul className="divide-y divide-[#E6EAE7]">
            {rows.map((r) => {
              const custom = amount[r.id]?.trim();
              return (
                <li key={r.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-semibold">{r.order.orderNumber} · {r.item.productName} × {r.quantity}</p>
                      <p className="text-sm text-[#4A5550]">{RETURN_REASONS[r.reason]} · {r.opened ? 'opened' : 'unopened'} · SKU {r.item.sku}</p>
                      {r.details && <p className="break-words text-sm">“{r.details}”</p>}
                      <p className="text-xs text-[#4A5550]">Requested {formatDateTime(r.createdAt)}{r.decisionNote ? ` · note: ${r.decisionNote}` : ''}</p>
                    </div>
                    <Pill tone={RETURN_TONE[r.status]}>{r.status.toLowerCase()}</Pill>
                  </div>
                  {canDecide && r.status === 'REQUESTED' && (
                    <div className="flex flex-wrap items-end gap-2">
                      <input aria-label="Note for the customer (optional)" placeholder="Note (optional)" maxLength={300} className={`${adminInput} max-w-xs`} value={note[r.id] ?? ''} onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))} />
                      <button className={adminButton} disabled={busyId === r.id} onClick={() => void act(r.id, 'Return approved.', () => adminPost(`/admin/returns/${r.id}/decision`, { decision: 'APPROVED', ...(note[r.id]?.trim() ? { note: note[r.id]!.trim() } : {}) }))}>Approve</button>
                      <button className={adminGhostButton} disabled={busyId === r.id} onClick={() => void act(r.id, 'Return rejected.', () => adminPost(`/admin/returns/${r.id}/decision`, { decision: 'REJECTED', ...(note[r.id]?.trim() ? { note: note[r.id]!.trim() } : {}) }))}>Reject</button>
                    </div>
                  )}
                  {canDecide && r.status === 'APPROVED' && (
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label="Refund amount (₹)" hint="Leave blank to refund the item price automatically.">
                        <input inputMode="decimal" className={adminInput} value={amount[r.id] ?? ''} onChange={(e) => setAmount((a) => ({ ...a, [r.id]: e.target.value }))} />
                      </Field>
                      <button
                        className={adminButton}
                        disabled={busyId === r.id}
                        onClick={() => {
                          const refundAmountMinor = custom ? rupeesToPaise(custom) : undefined;
                          if (custom && (refundAmountMinor === null || refundAmountMinor === undefined || refundAmountMinor < 1)) return setError('Enter a valid refund amount in rupees.');
                          void act(r.id, 'Marked as received. The refund has been requested.', () => adminPost(`/admin/returns/${r.id}/received`, refundAmountMinor ? { refundAmountMinor } : {}));
                        }}
                      >
                        Goods received
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>
    </>
  );
}
