"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Clock, Loader2, XCircle } from "lucide-react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/components/AuthProvider";
import { ProductImage } from "@/components/ProductImage";
import { formatIndianDate, formatPaise } from "@/lib/formatters";
import { ApiError } from "@/lib/http";
import {
  AWAITING_PAYMENT,
  checkoutApi,
  checkoutErrorMessage,
  CustomerOrder,
  formatPhone,
  PAID_STATUSES,
  payForOrder,
} from "@/lib/checkout-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 3000;
const POLL_LIMIT = 20; // ~1 minute, then ask the customer to refresh

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="flex-1 max-w-[1000px] w-full mx-auto px-4 md:px-8 py-8 md:py-10 space-y-6">{children}</main>
      <Footer />
    </>
  );
}

function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return { seconds: s, label: `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` };
}

export function OrderConfirmation({ id }: { id: string }) {
  const router = useRouter();
  const { status: authStatus } = useAuth();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState<{ message: string; notFound?: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pay" | "cancel" | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const polls = useRef(0);
  const countdown = useCountdown(order && AWAITING_PAYMENT.includes(order.status) ? order.paymentExpiresAt : null);

  const load = useCallback(async () => {
    if (!UUID.test(id)) {
      setError({ message: "We couldn’t find that order.", notFound: true });
      return null;
    }
    try {
      const o = await checkoutApi.order(id);
      setOrder(o);
      setError(null);
      return o;
    } catch (e) {
      setError({ message: checkoutErrorMessage(e), notFound: e instanceof ApiError && e.status === 404 });
      return null;
    }
  }, [id]);

  useEffect(() => {
    if (authStatus === "anonymous") router.replace(`/auth/login?next=${encodeURIComponent(`/orders/${id}/confirmation`)}`);
    if (authStatus !== "authenticated") return;
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    const stored = sessionStorage.getItem(`yalli_pay_err_${id}`);
    sessionStorage.removeItem(`yalli_pay_err_${id}`);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time notice from the checkout redirect
    if (payment === "failed") setNotice(stored || "The payment didn’t go through. You can try again below.");
    else if (payment === "dismissed") setNotice("Payment was not completed. Your order is saved — pay below before the timer runs out.");
    void load().then((o) => {
      if (payment === "pending" && o && AWAITING_PAYMENT.includes(o.status)) setPolling(true);
    });
  }, [authStatus, id, load, router]);

  // The webhook may arrive a few seconds after Razorpay's window closes.
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(async () => {
      polls.current += 1;
      const o = await load();
      if (!o || !AWAITING_PAYMENT.includes(o.status) || polls.current >= POLL_LIMIT) {
        setPolling(false);
        setPollTimedOut(!!o && AWAITING_PAYMENT.includes(o.status));
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [polling, load]);

  const retryPay = async () => {
    if (!order) return;
    setBusy("pay");
    setNotice(null);
    try {
      const r = await payForOrder(order.id, `pay-${order.id}`);
      if (r.kind === "paid") setOrder(r.order);
      else if (r.kind === "pending") {
        polls.current = 0;
        setPolling(true);
      } else if (r.kind === "failed") setNotice(r.message);
      else setNotice("Payment was not completed. You can try again before the timer runs out.");
    } catch (e) {
      setNotice(checkoutErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!order || !window.confirm("Cancel this order? Reserved items will be released.")) return;
    setBusy("cancel");
    try {
      setOrder(await checkoutApi.cancel(order.id));
      setNotice(null);
    } catch (e) {
      setNotice(checkoutErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (error && !order) {
    return (
      <Shell>
        <div className="py-16 text-center space-y-4">
          <h1 className="font-heading text-2xl font-bold text-[#113322]">{error.notFound ? "Order not found" : "Couldn’t load your order"}</h1>
          <p className="text-[#5C6B62]">{error.message}</p>
          <div className="flex justify-center gap-3">
            {!error.notFound && (
              <button type="button" onClick={() => void load()} className="rounded-xl bg-[#116644] px-5 py-2.5 text-[14px] font-semibold text-white">
                Try again
              </button>
            )}
            <Link href="/account/orders" className="rounded-xl border border-[#D5DDD8] px-5 py-2.5 text-[14px] font-semibold text-[#113322]">
              My orders
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  if (!order) {
    return (
      <Shell>
        <div className="py-24 flex justify-center" role="status">
          <Loader2 className="w-8 h-8 text-[#116644] animate-spin" aria-hidden />
          <span className="sr-only">Loading your order…</span>
        </div>
      </Shell>
    );
  }

  const paid = PAID_STATUSES.includes(order.status);
  const awaiting = AWAITING_PAYMENT.includes(order.status);
  const expired = awaiting && countdown?.seconds === 0;
  const a = order.shippingAddress;

  const hero = paid
    ? { icon: <Check className="w-8 h-8" aria-hidden />, tone: "bg-[#116644] text-white", title: "Thank you! Your order is confirmed", text: "We’ve emailed your receipt. You’ll get another update when it ships." }
    : awaiting && polling
      ? { icon: <Loader2 className="w-8 h-8 animate-spin" aria-hidden />, tone: "bg-[#E6F2EC] text-[#116644]", title: "Confirming your payment…", text: "This usually takes a few seconds. Please don’t pay again." }
      : awaiting
        ? { icon: <Clock className="w-8 h-8" aria-hidden />, tone: "bg-[#FFF4E5] text-[#B54708]", title: expired ? "Payment window expired" : "Complete your payment", text: expired ? "The reserved stock will be released shortly. If you were charged, the amount is refunded automatically." : "Your order is saved and stock is reserved until the timer runs out." }
        : { icon: <XCircle className="w-8 h-8" aria-hidden />, tone: "bg-[#FDECEC] text-[#B42318]", title: order.status === "CANCELLED" ? "Order cancelled" : `Order ${order.status.toLowerCase().replace(/_/g, " ")}`, text: order.status === "CANCELLED" ? "No payment was taken for this order." : "See your order history for details." };

  return (
    <Shell>
      <section className="text-center space-y-3" aria-live="polite">
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${hero.tone}`}>{hero.icon}</div>
        <h1 className="font-heading text-[26px] md:text-[32px] font-bold text-[#113322]">{hero.title}</h1>
        <p className="text-[#5C6B62] max-w-lg mx-auto">{hero.text}</p>
        <p className="text-[14px] text-[#113322]">
          Order <span className="font-semibold">#{order.orderNumber}</span> · placed {formatIndianDate(order.placedAt)}
        </p>
      </section>

      {notice && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-[#F5C2C0] bg-[#FDECEC] p-4 text-[14px] text-[#B42318]">
          <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden /> {notice}
        </p>
      )}

      {awaiting && !polling && !expired && (
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={retryPay}
            disabled={busy !== null}
            className="w-full sm:w-auto rounded-xl bg-[#116644] px-6 py-3 text-[15px] font-bold text-white disabled:opacity-50"
          >
            {busy === "pay" ? "Opening payment…" : `Pay ${formatPaise(order.totals.totalMinor)}`}
            {countdown && <span className="ml-2 font-mono text-[13px] font-normal opacity-90">({countdown.label} left)</span>}
          </button>
          {order.cancellable && (
            <button
              type="button"
              onClick={cancel}
              disabled={busy !== null}
              className="w-full sm:w-auto rounded-xl border border-[#D5DDD8] px-6 py-3 text-[15px] font-semibold text-[#113322] disabled:opacity-50"
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel order"}
            </button>
          )}
        </div>
      )}
      {awaiting && !polling && pollTimedOut && (
        <p className="text-center text-[13px] text-[#5C6B62]">
          Still waiting for the bank. If money was debited, don’t pay again — refresh this page in a minute.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
        <section className="bg-white border border-[#E1E8E4] rounded-2xl p-5 min-w-0" aria-labelledby="items-h">
          <h2 id="items-h" className="font-heading text-[17px] font-bold text-[#113322] mb-4">Items</h2>
          <ul className="space-y-3">
            {order.items.map((i) => (
              <li key={i.id} className="flex gap-3 min-w-0">
                <div className="relative w-14 h-14 shrink-0 overflow-hidden rounded-lg bg-[#F2F4F3]">
                  <ProductImage src={i.imageUrl} alt={i.productName} sizes="56px" className="object-cover" />
                </div>
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-semibold text-[#113322] line-clamp-2">{i.productName}</p>
                  <p className="text-[#8A958E]">{[i.variantName, `Qty ${i.quantity}`].filter(Boolean).join(" · ")}</p>
                </div>
                <span className="shrink-0 text-[13px] font-semibold text-[#113322]">{formatPaise(i.lineTotalMinor)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-2 border-t border-[#E1E8E4] pt-4 text-[14px] text-[#5C6B62]">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="text-[#113322]">{formatPaise(order.totals.subtotalMinor)}</dd></div>
            {order.totals.discountMinor > 0 && (
              <div className="flex justify-between"><dt>Discount{order.couponCode ? ` (${order.couponCode})` : ""}</dt><dd className="text-[#116644]">− {formatPaise(order.totals.discountMinor)}</dd></div>
            )}
            <div className="flex justify-between"><dt>Shipping{order.shippingMethod ? ` · ${order.shippingMethod.name}` : ""}</dt><dd className="text-[#113322]">{order.totals.shippingMinor ? formatPaise(order.totals.shippingMinor) : "Free"}</dd></div>
            <div className="flex justify-between border-t border-[#E1E8E4] pt-3 text-[16px] font-bold text-[#113322]"><dt>Total</dt><dd>{formatPaise(order.totals.totalMinor)}</dd></div>
            <p className="text-[12px] text-[#8A958E]">Includes GST {formatPaise(order.totals.gstIncludedMinor)}</p>
          </dl>
        </section>

        <aside className="bg-white border border-[#E1E8E4] rounded-2xl p-5 text-[14px] space-y-2 min-w-0 h-fit">
          <h2 className="font-heading text-[17px] font-bold text-[#113322]">Delivering to</h2>
          <p className="font-semibold text-[#113322]">{a.name}</p>
          <p className="text-[#5C6B62] break-words">
            {[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}, {a.city}, {a.state} {a.postalCode}
          </p>
          <p className="text-[#5C6B62]">{formatPhone(a.phone)}</p>
        </aside>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/account/orders" className="rounded-xl border border-[#D5DDD8] px-5 py-2.5 text-[14px] font-semibold text-[#113322]">View my orders</Link>
        <Link href="/catalog" className="rounded-xl bg-[#116644] px-5 py-2.5 text-[14px] font-semibold text-white">Continue shopping</Link>
      </div>
    </Shell>
  );
}
