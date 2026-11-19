'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminGet, adminList, adminPost } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { ORDER_STATUS_LABEL, type Shipment } from '@/lib/account-api';
import { AWAITING_PAYMENT, type CustomerOrder, type OrderStatus } from '@/lib/checkout-api';
import { formatDateTime, formatPaise } from '@/lib/formatters';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  totalMinor: number;
  contactEmail: string;
  shipCity: string | null;
  shipState: string | null;
}
type AdminOrder = CustomerOrder & {
  contactEmail: string;
  contactPhone: string | null;
  history: { from: OrderStatus | null; to: OrderStatus; at: string; actorType: string; reason: string | null }[];
  returns: { id: string; status: string }[];
};
interface PaymentRow {
  id: string;
  status: string;
  amountMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  attempt: number;
  method: string | null;
  providerPaymentId: string | null;
  failureCode: string | null;
  createdAt: string;
}

const STATUSES = Object.keys(ORDER_STATUS_LABEL) as OrderStatus[];
const CARRIERS = ['Delhivery', 'India Post', 'DTDC', 'Blue Dart', 'Ecom Express', 'Shiprocket', 'Other'];
const EVENT_LABEL = {
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERY_FAILED: 'Delivery attempt failed',
  DELIVERED: 'Delivered',
  RETURNED_TO_SELLER: 'Returned to seller',
} as const;
const CANCELLABLE: OrderStatus[] = [...AWAITING_PAYMENT, 'PAID', 'PROCESSING'];

function tone(status: OrderStatus) {
  if (['DELIVERED', 'PAID', 'PROCESSING', 'SHIPPED'].includes(status)) return 'green' as const;
  if (['CANCELLED', 'PAYMENT_FAILED', 'REFUND_PENDING'].includes(status)) return 'red' as const;
  if (['REFUNDED', 'PARTIALLY_REFUNDED', 'RETURNED'].includes(status)) return 'gray' as const;
  return 'amber' as const;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function AdminOrdersPage() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const list = useAdminQuery(() => adminList<OrderRow>('/admin/orders', { q, status, page, pageSize: 20 }), [q, status, page]);
  const rows = list.data?.items ?? [];

  return (
    <AdminPage eyebrow="Operations" title="Orders & fulfilment" subtitle="Follow every order from payment to doorstep.">
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_480px]">
        <section className={`${adminCard} min-w-0`}>
          <form
            className="flex flex-wrap gap-3 border-b border-[#E6EAE7] p-4"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setQ(search.trim());
            }}
          >
            <label className="relative min-w-[200px] flex-1">
              <span className="sr-only">Search by order number or email</span>
              <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
              <input className={`${adminInput} pl-9`} placeholder="Order number or customer email" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <select aria-label="Filter by status" className="rounded-xl border border-[#DCE3DE] bg-white p-2 text-sm" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]} ({s.toLowerCase().replaceAll('_', ' ')})</option>)}
            </select>
            <button className={adminGhostButton}>Search</button>
          </form>
          <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle={q || status ? 'No matching orders' : 'No orders yet'} emptyHint={q || status ? 'Try another search or status.' : 'Orders appear here as customers check out.'}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]">
                  <tr><th className="p-4">Order</th><th className="p-4">Customer</th><th className="p-4">Placed</th><th className="p-4 text-right">Total</th><th className="p-4">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-[#E6EAE7]">
                  {rows.map((o) => (
                    <tr key={o.id} className={selected === o.id ? 'bg-[#EEFFEE]' : undefined}>
                      <td className="p-4">
                        <button className="font-semibold text-[#116644] underline" onClick={() => setSelected(o.id)}>{o.orderNumber}</button>
                      </td>
                      <td className="break-all p-4">{o.contactEmail}{o.shipCity && <span className="block text-xs text-[#4A5550]">{o.shipCity}, {o.shipState}</span>}</td>
                      <td className="whitespace-nowrap p-4">{formatDateTime(o.placedAt)}</td>
                      <td className="p-4 text-right">{formatPaise(o.totalMinor)}</td>
                      <td className="p-4"><Pill tone={tone(o.status)}>{ORDER_STATUS_LABEL[o.status]}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
          </DataState>
        </section>

        {selected ? (
          <OrderDetail key={selected} id={selected} onClose={() => setSelected(null)} onChanged={list.reload} />
        ) : (
          <section className={`${adminCard} hidden p-8 text-center text-sm text-[#4A5550] xl:block`}>Select an order to see its items, payment and shipping.</section>
        )}
      </div>
    </AdminPage>
  );
}

function OrderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { withStepUp, can } = useAdminSession();
  const order = useAdminQuery(() => adminGet<AdminOrder>(`/admin/orders/${id}`), [id]);
  const tracking = useAdminQuery(() => adminGet<{ shipment: Shipment | null }>(`/admin/orders/${id}/tracking`), [id]);
  // Payment details need payments.read: without it the request is not even made.
  const canSeePayments = can('payments.read');
  const payments = useAdminQuery(() => (canSeePayments ? adminGet<PaymentRow[]>(`/admin/orders/${id}/payments`).catch(() => null) : Promise.resolve(null)), [id, canSeePayments]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [carrier, setCarrier] = useState('Delhivery');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [event, setEvent] = useState<keyof typeof EVENT_LABEL>('IN_TRANSIT');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  async function act(message: string, call: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await withStepUp(call);
      setNotice(message);
      order.reload();
      tracking.reload();
      payments.reload();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const o = order.data;
  const shipment = tracking.data?.shipment ?? null;

  return (
    <section className={`${adminCard} min-w-0 space-y-5 p-5`} aria-label="Order details">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-bold">{o ? o.orderNumber : 'Order'}</h2>
          {o && <p className="text-sm text-[#4A5550]">Placed {formatDateTime(o.placedAt)}</p>}
        </div>
        <button className={adminGhostButton} onClick={onClose}>Close</button>
      </div>
      {order.error && <Alert kind="error">{order.error}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {!o ? (
        order.error ? null : <p role="status" className="text-sm">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={tone(o.status)}>{ORDER_STATUS_LABEL[o.status]}</Pill>
            <span className="text-xs text-[#4A5550]">{o.status.toLowerCase().replaceAll('_', ' ')}</span>
          </div>

          <div className="space-y-1 text-sm">
            <p className="break-all font-semibold">{o.contactEmail}{o.contactPhone ? ` · ${o.contactPhone}` : ''}</p>
            <p className="text-[#4A5550]">{o.shippingAddress.name}, {o.shippingAddress.line1}{o.shippingAddress.line2 ? `, ${o.shippingAddress.line2}` : ''}, {o.shippingAddress.city}, {o.shippingAddress.state} {o.shippingAddress.postalCode}</p>
            {o.shippingMethod && <p className="text-[#4A5550]">Shipping: {o.shippingMethod.name}</p>}
          </div>

          <ul className="divide-y divide-[#E6EAE7] rounded-xl border border-[#E6EAE7] text-sm">
            {o.items.map((i) => (
              <li key={i.id} className="flex justify-between gap-3 p-3">
                <span className="min-w-0 break-words">{i.productName}{i.variantName ? ` · ${i.variantName}` : ''} <span className="text-[#4A5550]">× {i.quantity} · {i.sku}</span></span>
                <span className="shrink-0">{formatPaise(i.lineTotalMinor)}</span>
              </li>
            ))}
            <li className="flex justify-between p-3 text-[#4A5550]"><span>Delivery</span><span>{formatPaise(o.totals.shippingMinor)}</span></li>
            {o.totals.discountMinor > 0 && <li className="flex justify-between p-3 text-[#4A5550]"><span>Discount{o.couponCode ? ` (${o.couponCode})` : ''}</span><span>-{formatPaise(o.totals.discountMinor)}</span></li>}
            <li className="flex justify-between p-3 font-bold"><span>Total (GST incl. {formatPaise(o.totals.gstIncludedMinor)})</span><span>{formatPaise(o.totals.totalMinor)}</span></li>
          </ul>

          {payments.data && payments.data.length > 0 && (
            <div className="space-y-2 text-sm">
              <h3 className="font-semibold">Payments</h3>
              {payments.data.map((p) => (
                <p key={p.id} className="rounded-xl bg-[#F7F9F8] p-3">
                  Attempt {p.attempt}: <strong>{p.status.toLowerCase().replaceAll('_', ' ')}</strong>{p.method ? ` via ${p.method}` : ''} · {formatPaise(p.amountMinor)}
                  {p.refundedMinor > 0 && ` · refunded ${formatPaise(p.refundedMinor)}`}
                  {p.failureCode && ` · ${p.failureCode}`}
                  {p.providerPaymentId && <span className="block break-all text-xs text-[#4A5550]">Razorpay {p.providerPaymentId}</span>}
                </p>
              ))}
            </div>
          )}

          {/* Fulfilment: one forward step at a time; the server enforces the order of steps. */}
          <div className="space-y-3 border-t border-[#E6EAE7] pt-4">
            <h3 className="font-semibold">Fulfilment</h3>
            {can('orders.update') && o.status === 'PAID' && (
              <button className={adminButton} disabled={busy} onClick={() => void act('Order moved to packing.', () => adminPost(`/admin/orders/${id}/fulfilment`, { status: 'PROCESSING' }))}>Start packing</button>
            )}
            {can('orders.update') && o.status === 'PROCESSING' && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('Order marked as shipped. The customer is notified.', () => adminPost(`/admin/orders/${id}/fulfilment`, { status: 'SHIPPED', trackingCarrier: carrier, trackingNumber: trackingNumber.trim() }));
                }}
              >
                <Field label="Courier">
                  <select className={adminInput} value={carrier} onChange={(e) => setCarrier(e.target.value)}>{CARRIERS.map((c) => <option key={c}>{c}</option>)}</select>
                </Field>
                <Field label="Tracking number" hint="Must be unique per order.">
                  <input required minLength={3} maxLength={80} className={adminInput} value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
                </Field>
                <button className={adminButton} disabled={busy}>Mark as shipped</button>
              </form>
            )}
            {o.status === 'SHIPPED' && (
              <>
                {can('orders.update') && <button className={adminButton} disabled={busy} onClick={() => void act('Order marked as delivered.', () => adminPost(`/admin/orders/${id}/fulfilment`, { status: 'DELIVERED' }))}>Mark as delivered</button>}
                {can('shipments.manage') && <form
                  className="space-y-3 rounded-xl border border-[#E6EAE7] p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('Tracking update added.', () => adminPost(`/admin/orders/${id}/tracking`, { status: event, ...(location.trim() ? { location: location.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }));
                  }}
                >
                  <Field label="Add tracking update">
                    <select className={adminInput} value={event} onChange={(e) => setEvent(e.target.value as keyof typeof EVENT_LABEL)}>
                      {(Object.keys(EVENT_LABEL) as (keyof typeof EVENT_LABEL)[]).map((k) => <option key={k} value={k}>{EVENT_LABEL[k]}</option>)}
                    </select>
                  </Field>
                  <input aria-label="Location" placeholder="Location (optional)" minLength={2} maxLength={120} className={adminInput} value={location} onChange={(e) => setLocation(e.target.value)} />
                  <input aria-label="Note" placeholder="Note (optional)" minLength={2} maxLength={200} className={adminInput} value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className={adminGhostButton} disabled={busy}>Add update</button>
                </form>}
              </>
            )}
            {!can('orders.update') && <p className="text-sm text-[#4A5550]">View only: your role can see this order but not change it.</p>}
            {can('orders.update') && !['PAID', 'PROCESSING', 'SHIPPED'].includes(o.status) && <p className="text-sm text-[#4A5550]">No fulfilment step is available while the order is “{ORDER_STATUS_LABEL[o.status].toLowerCase()}”.</p>}
            {shipment && (
              <div className="rounded-xl bg-[#F7F9F8] p-3 text-sm">
                <p className="break-all font-semibold">{shipment.carrier} · {shipment.trackingNumber}</p>
                <ul className="mt-2 space-y-1 text-[#4A5550]">
                  {shipment.events.map((ev, i) => <li key={i}>{formatDateTime(ev.occurredAt)} · {ev.status.toLowerCase().replaceAll('_', ' ')}{ev.location ? ` · ${ev.location}` : ''}{ev.note ? ` · ${ev.note}` : ''}</li>)}
                </ul>
              </div>
            )}
          </div>

          {can('orders.update') && CANCELLABLE.includes(o.status) && (
            <div className="space-y-3 border-t border-[#E6EAE7] pt-4">
              {!cancelling ? (
                <button className={adminDangerButton} onClick={() => setCancelling(true)}>Cancel order…</button>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!window.confirm(`Cancel ${o.orderNumber}? ${o.paidAt ? 'The customer is refunded in full to the original payment method.' : ''}`)) return;
                    void act('Order cancelled.', () => adminPost(`/admin/orders/${id}/cancel`, { reason: cancelReason.trim() })).then(() => setCancelling(false));
                  }}
                >
                  <Field label="Reason (shown in the order history)">
                    <input required minLength={3} maxLength={200} className={adminInput} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                  </Field>
                  <div className="flex gap-2">
                    <button className={adminDangerButton} disabled={busy}>Confirm cancellation</button>
                    <button type="button" className={adminGhostButton} onClick={() => setCancelling(false)}>Keep order</button>
                  </div>
                </form>
              )}
            </div>
          )}

          <div className="space-y-2 border-t border-[#E6EAE7] pt-4 text-sm">
            <h3 className="font-semibold">History</h3>
            <ol className="space-y-1 text-[#4A5550]">
              {o.history.map((h, i) => <li key={i}>{formatDateTime(h.at)} · {ORDER_STATUS_LABEL[h.to]} <span className="text-xs">({h.actorType.toLowerCase()}{h.reason ? `: ${h.reason}` : ''})</span></li>)}
            </ol>
            {o.returns.length > 0 && <p className="text-[#4A5550]">{o.returns.length} return request(s). Manage them under Refunds &amp; returns.</p>}
          </div>
        </>
      )}
    </section>
  );
}
