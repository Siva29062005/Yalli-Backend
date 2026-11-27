'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, Pill, adminButton, adminCard, adminGhostButton, adminInput } from '@/components/AdminKit';
import { RETURN_REASONS, ORDER_STATUS_LABEL, type ReturnReason } from '@/lib/account-api';
import { adminGet, adminPost } from '@/lib/admin-api';
import type { OrderStatus } from '@/lib/checkout-api';
import { formatDateTime, formatPaise } from '@/lib/formatters';

type By = 'email' | 'phone' | 'order';
interface CustomerSummary {
  id: string;
  name: string | null;
  /** Masked by the server. */
  email: string;
  /** Masked by the server. */
  phone: string | null;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  emailVerified: boolean;
  phoneVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
interface CustomerDetail extends CustomerSummary {
  orders: { id: string; orderNumber: string; status: OrderStatus; placedAt: string; totalMinor: number }[];
  returns: { id: string; status: string; quantity: number; reason: ReturnReason; createdAt: string; order: { id: string; orderNumber: string }; item: { productName: string } }[];
}

const BY_LABEL: Record<By, string> = { email: 'Email address', phone: 'Phone number', order: 'Order number' };
const STATUS_TONE = { ACTIVE: 'green', PENDING_VERIFICATION: 'amber', SUSPENDED: 'red', DEACTIVATED: 'gray' } as const;
const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.');

/**
 * Support's customer lookup (customers.read). Search needs the caller's EXACT email, phone or order number (no
 * browsing); contact details come back masked; every search and view is recorded by the server.
 */
export default function AdminCustomersPage() {
  const { withStepUp } = useAdminSession();
  const [by, setBy] = useState<By>('email');
  const [value, setValue] = useState('');
  const [results, setResults] = useState<CustomerSummary[] | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    setDetail(null);
    try {
      // POST: the searched email/phone must never be part of a URL (access logs)
      setResults(await withStepUp(() => adminPost<CustomerSummary[]>('/admin/customers/search', { [by]: value.trim() })));
    } catch (e) {
      setResults(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    setBusy(true);
    setError('');
    try {
      setDetail(await withStepUp(() => adminGet<CustomerDetail>(`/admin/customers/${id}`)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminPage eyebrow="Support" title="Customers" subtitle="Find a customer with the exact email, phone number or order number they give you. Contact details are partly hidden, and every lookup is recorded.">
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={search} className={`${adminCard} flex flex-wrap items-end gap-3 p-4`}>
        <label className="text-sm font-medium">
          Search by
          <select className={`${adminInput} mt-1`} value={by} onChange={(e) => { setBy(e.target.value as By); setResults(null); setDetail(null); setValue(''); setError(''); }}>
            {(Object.keys(BY_LABEL) as By[]).map((k) => <option key={k} value={k}>{BY_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="relative min-w-[240px] flex-1 text-sm font-medium">
          {BY_LABEL[by]}
          <Search className="absolute bottom-3 left-3 h-4 w-4 text-[#4A5550]" aria-hidden />
          <input
            required
            className={`${adminInput} mt-1 pl-9`}
            type={by === 'email' ? 'email' : 'text'}
            inputMode={by === 'phone' ? 'tel' : undefined}
            maxLength={by === 'email' ? 254 : 20}
            placeholder={by === 'email' ? 'name@example.com' : by === 'phone' ? '98765 43210' : 'YL26-000123'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <button className={adminButton} disabled={busy}>{busy ? 'Searching…' : 'Find customer'}</button>
      </form>

      {results !== null && results.length === 0 && (
        <Alert kind="warning">No customer matches. Check the spelling with the caller; a phone number is found only once the customer has verified it, and staff accounts are not shown here.</Alert>
      )}
      {results && results.length > 0 && !detail && (
        <ul className={`${adminCard} divide-y divide-[#E6EAE7]`} aria-label="Matching customers">
          {results.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="break-words font-semibold">{c.name ?? 'Customer'}</p>
                <p className="text-sm text-[#4A5550]">{c.email}{c.phone ? ` · ${c.phone}` : ''}</p>
              </div>
              <button type="button" className={adminGhostButton} disabled={busy} onClick={() => void open(c.id)}>Open</button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <section className={`${adminCard} space-y-5 p-5`} aria-label="Customer details">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words font-heading text-xl font-bold">{detail.name ?? 'Customer'}</h2>
              <p className="text-sm text-[#4A5550]">
                {detail.email} {detail.emailVerified ? '(verified)' : '(not verified)'}
                {detail.phone ? ` · ${detail.phone} ${detail.phoneVerified ? '(verified)' : '(not verified)'}` : ''}
              </p>
              <p className="text-xs text-[#4A5550]">
                Customer since {formatDateTime(detail.createdAt)} · last sign-in {detail.lastLoginAt ? formatDateTime(detail.lastLoginAt) : 'never'} · two-step verification {detail.mfaEnabled ? 'on' : 'off'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Pill tone={STATUS_TONE[detail.status]}>{detail.status.toLowerCase().replaceAll('_', ' ')}</Pill>
              <button type="button" className={adminGhostButton} onClick={() => setDetail(null)}>Back</button>
            </div>
          </div>

          <div>
            <h3 className="mb-2 font-semibold">Recent orders</h3>
            {detail.orders.length === 0 ? (
              <p className="text-sm text-[#4A5550]">No orders yet.</p>
            ) : (
              <ul className="divide-y divide-[#E6EAE7] rounded-xl border border-[#E6EAE7] text-sm">
                {detail.orders.map((o) => (
                  <li key={o.id} className="flex flex-wrap justify-between gap-3 p-3">
                    <span className="font-semibold">{o.orderNumber}</span>
                    <span className="text-[#4A5550]">{ORDER_STATUS_LABEL[o.status] ?? o.status} · {formatDateTime(o.placedAt)}</span>
                    <span>{formatPaise(o.totalMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 font-semibold">Return requests</h3>
            {detail.returns.length === 0 ? (
              <p className="text-sm text-[#4A5550]">No return requests.</p>
            ) : (
              <ul className="divide-y divide-[#E6EAE7] rounded-xl border border-[#E6EAE7] text-sm">
                {detail.returns.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <span className="min-w-0 break-words">{r.order.orderNumber} · {r.item.productName} × {r.quantity} · {RETURN_REASONS[r.reason] ?? r.reason}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-[#4A5550]">{r.status.toLowerCase()} · {formatDateTime(r.createdAt)}</span>
                      <Link href={`/admin/refunds?tab=returns&order=${r.order.id}`} className="font-semibold text-[#116644] underline">Open</Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </AdminPage>
  );
}
