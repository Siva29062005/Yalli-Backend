"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FileText, Package, Truck, Undo2, XCircle } from "lucide-react";
import { AccountShell, PanelError, PanelLoading, inputClass, primaryButton, secondaryButton } from "@/components/AccountShell";
import { ProductImage } from "@/components/ProductImage";
import { accountApi, ORDER_STATUS_LABEL, RETURN_REASONS, statusTone, type ReturnReason, type Shipment } from "@/lib/account-api";
import { AWAITING_PAYMENT, formatPhone, type CustomerOrder } from "@/lib/checkout-api";
import { formatIndianDate, formatPaise } from "@/lib/formatters";
import { ApiError } from "@/lib/http";
import { useAsync } from "@/lib/useAsync";

type Order = CustomerOrder & { shippedAt?: string | null; deliveredAt?: string | null; cancelledAt?: string | null };

const NOT_FOUND = "__order_not_found__";

const STEPS = [
  { key: "placed", label: "Placed" },
  { key: "paid", label: "Confirmed" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
] as const;

function progress(o: Order): number {
  if (o.deliveredAt || ["DELIVERED", "RETURN_REQUESTED", "RETURN_APPROVED", "RETURNED"].includes(o.status)) return 3;
  if (o.shippedAt || o.status === "SHIPPED") return 2;
  if (o.paidAt) return 1;
  return 0;
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: order, setData, error, loading, reload } = useAsync<Order>(
    () =>
      accountApi.order(id).catch((e: unknown) => {
        throw e instanceof ApiError && (e.status === 404 || e.status === 400) ? new Error(NOT_FOUND) : e;
      }),
    [id],
  );
  const tracking = useAsync<Shipment | null>(
    () => (order?.paidAt ? accountApi.tracking(id).then((r) => r.shipment) : Promise.resolve(null)),
    [id, order?.paidAt],
  );
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [returnFor, setReturnFor] = useState<string | null>(null);
  const [returned, setReturned] = useState<Set<string>>(new Set());
  const [invoiceBusy, setInvoiceBusy] = useState(false);

  const notFound = error === NOT_FOUND;

  const cancel = async () => {
    if (!order || !window.confirm(`Cancel order ${order.orderNumber}? Paid orders are refunded to the original payment method.`)) return;
    setCancelling(true);
    setActionError(null);
    try {
      setData(await accountApi.cancelOrder(order.id, "Cancelled by customer"));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not cancel the order.");
    } finally {
      setCancelling(false);
    }
  };

  const downloadInvoice = async () => {
    if (!order) return;
    setInvoiceBusy(true);
    setActionError(null);
    try {
      const inv = await accountApi.invoice(order.id);
      const { invoiceHtml } = await import("@/lib/invoice");
      const w = window.open("", "_blank");
      if (!w) throw new Error("Allow pop-ups for this site to view the invoice.");
      w.document.write(invoiceHtml(inv));
      w.document.close();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "The invoice is not available yet.");
    } finally {
      setInvoiceBusy(false);
    }
  };

  return (
    <AccountShell
      title={order ? `Order ${order.orderNumber}` : "Order details"}
      subtitle={order ? `Placed on ${formatIndianDate(order.placedAt)}` : undefined}
      crumbs={[{ label: "My orders", href: "/account/orders" }, { label: order?.orderNumber ?? "Order" }]}
    >
      {loading && !order ? (
        <PanelLoading label="Loading your order…" />
      ) : notFound ? (
        <PanelError message="We couldn’t find this order in your account." />
      ) : error || !order ? (
        <PanelError message={error ?? "Could not load the order."} onRetry={reload} />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <div className="xl:col-span-8 space-y-6 min-w-0">
            {/* Status */}
            <section className="rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={`rounded-full px-3 py-1 text-[12px] font-semibold ${statusTone(order.status)}`}>{ORDER_STATUS_LABEL[order.status]}</span>
                <div className="flex flex-wrap gap-2">
                  {order.paidAt && (
                    <button type="button" className={secondaryButton} onClick={downloadInvoice} disabled={invoiceBusy}>
                      <FileText className="h-4 w-4" /> {invoiceBusy ? "Preparing…" : "Invoice"}
                    </button>
                  )}
                  {AWAITING_PAYMENT.includes(order.status) && (
                    <Link href={`/orders/${order.id}/confirmation`} className={primaryButton}>
                      Complete payment
                    </Link>
                  )}
                  {order.cancellable && (
                    <button type="button" className={`${secondaryButton} text-red-700`} onClick={cancel} disabled={cancelling}>
                      <XCircle className="h-4 w-4" /> {cancelling ? "Cancelling…" : "Cancel order"}
                    </button>
                  )}
                </div>
              </div>
              {actionError && <p role="alert" className="text-[13px] text-red-600">{actionError}</p>}
              {order.status !== "CANCELLED" && !AWAITING_PAYMENT.includes(order.status) && (
                <ol className="grid grid-cols-4 gap-1" aria-label="Order progress">
                  {STEPS.map((s, i) => {
                    const done = i <= progress(order);
                    return (
                      <li key={s.key} className="space-y-2 min-w-0">
                        <div className={`h-1.5 rounded-full ${done ? "bg-[#116644]" : "bg-[#E6EAE7]"}`} />
                        <span className={`block text-[11px] sm:text-[12px] truncate ${done ? "font-semibold text-[#113322]" : "text-[#8A958E]"}`}>{s.label}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {order.status === "CANCELLED" && (
                <p className="text-[13px] text-[#4A5550]">
                  This order was cancelled{order.cancelledAt ? ` on ${formatIndianDate(order.cancelledAt)}` : ""}. Any payment taken is refunded to the original method.
                </p>
              )}
            </section>

            {/* Items */}
            <section className="rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-6 space-y-4">
              <h2 className="font-heading text-[18px] font-bold text-[#113322] flex items-center gap-2">
                <Package className="h-5 w-5 text-[#116644]" /> Items
              </h2>
              <ul className="divide-y divide-[#F0F2F1]">
                {order.items.map((i) => (
                  <li key={i.id} className="py-4 space-y-3">
                    <div className="flex gap-4 min-w-0">
                      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[#F7F8F7]">
                        <ProductImage src={i.imageUrl} alt="" sizes="64px" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-semibold text-[#113322] break-words">{i.productName}</p>
                        {i.variantName && <p className="text-[12px] text-[#8A958E]">{i.variantName}</p>}
                        <p className="text-[12px] text-[#8A958E]">Qty {i.quantity} · {formatPaise(i.unitPriceMinor)} each</p>
                      </div>
                      <span className="text-[14px] font-semibold text-[#113322] shrink-0">{formatPaise(i.lineTotalMinor)}</span>
                    </div>
                    {order.status === "DELIVERED" && !returned.has(i.id) && returnFor !== i.id && (
                      <button type="button" className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1" onClick={() => setReturnFor(i.id)}>
                        <Undo2 className="h-3.5 w-3.5" /> Return this item
                      </button>
                    )}
                    {returned.has(i.id) && <p role="status" className="text-[13px] text-[#116644]">Return requested. We’ll email you once it’s reviewed.</p>}
                    {returnFor === i.id && (
                      <ReturnForm
                        orderId={order.id}
                        item={i}
                        onCancel={() => setReturnFor(null)}
                        onDone={() => {
                          setReturned((s) => new Set(s).add(i.id));
                          setReturnFor(null);
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {/* Tracking */}
            {order.paidAt && (
              <section className="rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-6 space-y-4">
                <h2 className="font-heading text-[18px] font-bold text-[#113322] flex items-center gap-2">
                  <Truck className="h-5 w-5 text-[#116644]" /> Tracking
                </h2>
                {tracking.loading ? (
                  <p className="text-[13px] text-[#8A958E]">Loading tracking…</p>
                ) : tracking.error ? (
                  <p className="text-[13px] text-red-600">Tracking is unavailable right now.</p>
                ) : !tracking.data ? (
                  <p className="text-[13px] text-[#4A5550]">We’re packing your order. Tracking appears here once it ships.</p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[14px] text-[#113322] break-words">
                      {tracking.data.carrier ?? "Courier"}
                      {tracking.data.trackingNumber && <> · <span className="font-mono">{tracking.data.trackingNumber}</span></>}
                    </p>
                    <ol className="space-y-3 border-l-2 border-[#E0EFE5] pl-4">
                      {tracking.data.events.map((e, idx) => (
                        <li key={idx} className="text-[13px]">
                          <span className="font-semibold text-[#113322]">{e.status.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</span>
                          {e.location && <span className="text-[#4A5550]"> · {e.location}</span>}
                          <span className="block text-[12px] text-[#8A958E]">{new Date(e.occurredAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
                          {e.note && <span className="block text-[12px] text-[#4A5550]">{e.note}</span>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </section>
            )}
          </div>

          <aside className="xl:col-span-4 space-y-6">
            <section className="rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-6 space-y-3">
              <h2 className="font-heading text-[16px] font-bold text-[#113322]">Summary</h2>
              <dl className="space-y-2 text-[14px]">
                <Row label="Subtotal" value={formatPaise(order.totals.subtotalMinor)} />
                {order.totals.discountMinor > 0 && <Row label={`Discount${order.couponCode ? ` (${order.couponCode})` : ""}`} value={`−${formatPaise(order.totals.discountMinor)}`} />}
                <Row label={order.shippingMethod?.name ?? "Shipping"} value={order.totals.shippingMinor ? formatPaise(order.totals.shippingMinor) : "Free"} />
                <div className="flex justify-between border-t border-[#F0F2F1] pt-2 font-bold text-[#113322]">
                  <dt>Total</dt>
                  <dd>{formatPaise(order.totals.totalMinor)}</dd>
                </div>
                <p className="text-[12px] text-[#8A958E]">Includes {formatPaise(order.totals.gstIncludedMinor)} GST</p>
              </dl>
            </section>
            <section className="rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-6 space-y-2">
              <h2 className="font-heading text-[16px] font-bold text-[#113322]">Delivering to</h2>
              <p className="text-[14px] text-[#4A5550] break-words">
                <span className="font-semibold text-[#113322]">{order.shippingAddress.name}</span>
                <br />
                {[order.shippingAddress.line1, order.shippingAddress.line2, order.shippingAddress.landmark].filter(Boolean).join(", ")}
                <br />
                {order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}
              </p>
              <p className="text-[13px] text-[#8A958E]">{formatPhone(order.shippingAddress.phone)}</p>
            </section>
          </aside>
        </div>
      )}
    </AccountShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-[#4A5550]">
      <dt className="min-w-0 truncate">{label}</dt>
      <dd className="text-[#113322]">{value}</dd>
    </div>
  );
}

function ReturnForm({
  orderId,
  item,
  onCancel,
  onDone,
}: {
  orderId: string;
  item: CustomerOrder["items"][number];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [quantity, setQuantity] = useState(1);
  const [opened, setOpened] = useState(false);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsDetails = reason === "FAULTY" || reason === "OTHER";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason) return setError("Choose a reason.");
    if (needsDetails && details.trim().length < 5) return setError("Please describe the problem.");
    setBusy(true);
    setError(null);
    try {
      await accountApi.requestReturn(orderId, {
        orderItemId: item.id,
        quantity,
        reason,
        opened,
        ...(details.trim() ? { details: details.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request the return.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="rounded-xl border border-dashed border-[#B9CCC1] p-4 space-y-3" aria-label={`Return ${item.productName}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[13px] font-medium text-[#113322]">Reason</span>
          <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
            <option value="">Select a reason</option>
            {Object.entries(RETURN_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {item.quantity > 1 && (
          <label className="block space-y-1">
            <span className="text-[13px] font-medium text-[#113322]">Quantity</span>
            <select className={inputClass} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
              {Array.from({ length: item.quantity }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="block space-y-1">
        <span className="text-[13px] font-medium text-[#113322]">Details {needsDetails ? "" : "(optional)"}</span>
        <textarea className={inputClass} rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-[14px] text-[#113322]">
        <input type="checkbox" className="accent-[#116644]" checked={opened} onChange={(e) => setOpened(e.target.checked)} /> I’ve opened or used the item
      </label>
      {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>{busy ? "Sending…" : "Request return"}</button>
        <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
