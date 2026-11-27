"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Lock, Plus, ShieldCheck } from "lucide-react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/components/AuthProvider";
import { useCart } from "@/components/CartProvider";
import { CartErrorBanner } from "@/components/CartLineControls";
import { ProductImage } from "@/components/ProductImage";
import { formatPaise } from "@/lib/formatters";
import { AddressForm } from "@/components/AddressForm";
import { ApiError } from "@/lib/http";
import {
  checkoutApi,
  checkoutErrorMessage,
  formatPhone,
  idempotencyKeys,
  payAttemptKey,
  payForOrder,
  Quote,
  SavedAddress,
} from "@/lib/checkout-api";

const card = "bg-white border border-[#E1E8E4] rounded-2xl p-5 md:p-6";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 md:px-8 py-6 md:py-8 space-y-6">{children}</main>
      <Footer />
    </>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const { status: authStatus } = useAuth();
  const { cart, status: cartStatus, reload: reloadCart, error: cartError, removeCoupon, pending: cartPending } = useCart();

  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [shippingCode, setShippingCode] = useState<string | undefined>();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const keyFor = useRef(idempotencyKeys()).current;
  // Each quote request takes a number; only the newest one may set the quote (the effect's and the re-quote after a
  // refused order race otherwise, and an old answer would show a stale total).
  const quoteGen = useRef(0);

  useEffect(() => {
    if (authStatus === "anonymous") router.replace("/auth/login?next=%2Fcheckout");
  }, [authStatus, router]);

  const loadAddresses = useCallback(async () => {
    setAddressError(null);
    try {
      const list = await checkoutApi.addresses();
      setAddresses(list);
      setAddressId((cur) => cur ?? (list.find((a) => a.isDefault) ?? list[0])?.id ?? null);
      if (list.length === 0) setShowForm(true);
    } catch (e) {
      setAddressError(checkoutErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch once signed in
    if (authStatus === "authenticated") void loadAddresses();
  }, [authStatus, loadAddresses]);

  // Re-quote whenever the address, shipping choice or cart contents change. Totals always come from the server.
  const cartSig = useMemo(
    () => cart.items.map((i) => `${i.variantId}:${i.quantity}`).join(",") + `|${cart.coupon?.code ?? ""}`,
    [cart],
  );
  useEffect(() => {
    if (!addressId || cart.items.length === 0) return;
    const gen = ++quoteGen.current;
    let active = true;
    const current = () => active && gen === quoteGen.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for the request below
    setQuoting(true);
    setQuoteError(null);
    checkoutApi
      .quote(addressId, shippingCode)
      .then((q) => {
        if (!current()) return;
        setQuote(q);
        if (!shippingCode && q.shipping.selected) setShippingCode(q.shipping.selected);
        else if (!shippingCode && q.shipping.options.length > 0 && q.shipping.status === "CHOICE_REQUIRED")
          setShippingCode(q.shipping.options[0].code);
      })
      .catch((e) => current() && (setQuote(null), setQuoteError(checkoutErrorMessage(e))))
      .finally(() => current() && setQuoting(false));
    return () => {
      active = false;
    };
  }, [addressId, shippingCode, cartSig, cart.items.length]);

  const placeAndPay = async () => {
    if (!quote || !addressId) return;
    setPlacing(true);
    setPlaceError(null);
    const body = { addressId, expectedTotalMinor: quote.totals.totalMinor, shippingMethodCode: shippingCode };
    let orderId: string;
    try {
      const order = await checkoutApi.placeOrder(body, keyFor(body));
      orderId = order.id;
    } catch (e) {
      setPlacing(false);
      // Anything the server says changed (price, stock, delivery, the total): show the fresh cart and quote so the
      // customer sees why, instead of retrying into the same refusal.
      const stale = [
        "PRICE_CHANGED",
        "CART_HAS_UNAVAILABLE_ITEMS",
        "CART_EMPTY",
        "INSUFFICIENT_STOCK",
        "COUPON_INVALID",
        "COUPON_NOT_APPLICABLE",
        "SHIPPING_UNAVAILABLE",
        "SHIPPING_METHOD_INVALID",
        "SHIPPING_METHOD_REQUIRED",
        "ORDER_TOTAL_TOO_LOW",
      ];
      if (e instanceof ApiError && stale.includes(e.code ?? "")) {
        setPlaceError(
          e.code === "PRICE_CHANGED"
            ? "Prices changed since you opened checkout. Please review the updated total and try again."
            : checkoutErrorMessage(e),
        );
        void reloadCart();
        const gen = ++quoteGen.current;
        checkoutApi
          .quote(addressId, shippingCode)
          .then((q) => gen === quoteGen.current && setQuote(q))
          .catch(() => gen === quoteGen.current && setQuote(null));
      } else {
        setPlaceError(checkoutErrorMessage(e));
      }
      return;
    }
    // The order exists and stock is held; the server has emptied the cart.
    void reloadCart();
    let outcome = "pending";
    try {
      const r = await payForOrder(orderId, payAttemptKey(orderId));
      outcome = r.kind;
      if (r.kind === "failed") sessionStorage.setItem(`yalli_pay_err_${orderId}`, r.message);
    } catch (e) {
      outcome = "failed";
      sessionStorage.setItem(`yalli_pay_err_${orderId}`, checkoutErrorMessage(e, { afterOrder: true }));
    }
    router.replace(`/orders/${orderId}/confirmation${outcome === "paid" ? "" : `?payment=${outcome}`}`);
  };

  if (authStatus !== "authenticated" || cartStatus === "loading") {
    return (
      <Shell>
        <div className="py-24 flex justify-center" role="status">
          <Loader2 className="w-8 h-8 text-[#116644] animate-spin" aria-hidden />
          <span className="sr-only">Preparing secure checkout…</span>
        </div>
      </Shell>
    );
  }

  if (cartStatus === "error" && cart.items.length === 0) {
    return (
      <Shell>
        <div className="py-16 text-center space-y-4" role="alert">
          <h1 className="font-heading text-2xl font-bold text-[#113322]">We couldn’t load your cart</h1>
          <p className="text-[#5C6B62]">{cartError ?? "Please check your connection and try again."}</p>
          <button type="button" onClick={() => void reloadCart()} className="inline-block bg-[#116644] text-white font-semibold text-[14px] px-6 py-2.5 rounded-xl">
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  if (cart.items.length === 0 && !placing) {
    return (
      <Shell>
        <div className="py-16 text-center space-y-4">
          <h1 className="font-heading text-2xl font-bold text-[#113322]">Your cart is empty</h1>
          <p className="text-[#5C6B62]">Add something you love, then come back to checkout.</p>
          <Link href="/catalog" className="inline-block bg-[#116644] text-white font-semibold text-[14px] px-6 py-2.5 rounded-xl">
            Continue shopping
          </Link>
        </div>
      </Shell>
    );
  }

  const itemsBlocked = cart.items.some((i) => !i.purchasable) || (quote?.problems.length ?? 0) > 0;
  const deliveryBlocked = quote?.shipping.status === "UNAVAILABLE" || quote?.shipping.status === "INVALID_METHOD";
  const totalTooLow = quote !== null && quote.totals.totalMinor < quote.minimumPayableMinor;
  const blocked = itemsBlocked || (quote !== null && !quote.purchasable);
  const shipping = quote?.shipping;
  const canPlace = !!quote && !blocked && !quoting && !placing && !!addressId;

  return (
    <Shell>
      <nav className="text-[13px] text-[#5F6B64] flex items-center gap-2" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-[#116644]">Home</Link>
        <span>/</span>
        <Link href="/cart" className="hover:text-[#116644]">Cart</Link>
        <span>/</span>
        <span className="text-[#113322] font-medium">Secure checkout</span>
      </nav>

      <h1 className="font-heading text-[28px] md:text-[34px] font-bold text-[#113322] flex items-center gap-3">
        <Lock className="w-6 h-6 text-[#116644]" aria-hidden /> Secure checkout
      </h1>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] items-start">
        <div className="space-y-6 min-w-0">
          {/* Address */}
          <section className={card} aria-labelledby="addr-h">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 id="addr-h" className="font-heading text-[18px] font-bold text-[#113322]">1. Delivery address</h2>
              {addresses && addresses.length > 0 && !showForm && (
                <button type="button" onClick={() => setShowForm(true)} className="flex items-center gap-1 text-[14px] font-semibold text-[#116644]">
                  <Plus className="w-4 h-4" aria-hidden /> Add new
                </button>
              )}
            </div>
            {addressError ? (
              <div className="text-[14px] text-[#B42318] space-y-2">
                <p>{addressError}</p>
                <button type="button" onClick={loadAddresses} className="font-semibold underline">Try again</button>
              </div>
            ) : addresses === null ? (
              <p className="text-[14px] text-[#5F6B64]">Loading your addresses…</p>
            ) : (
              <div className="space-y-3">
                {addresses.length > 0 && (
                  <fieldset className="grid gap-3 sm:grid-cols-2">
                    <legend className="sr-only">Choose a delivery address</legend>
                    {addresses.map((a) => (
                      <label
                        key={a.id}
                        className={`block cursor-pointer rounded-xl border p-4 text-[14px] min-w-0 ${
                          a.id === addressId ? "border-[#116644] bg-[#F1F8F4] ring-1 ring-[#116644]" : "border-[#E1E8E4]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="address"
                          className="sr-only"
                          checked={a.id === addressId}
                          onChange={() => {
                            setAddressId(a.id);
                            setShippingCode(undefined);
                          }}
                        />
                        <span className="flex items-center gap-2 font-semibold text-[#113322]">
                          <span className="truncate">{a.fullName}</span>
                          {a.label && <span className="shrink-0 rounded bg-[#E6F2EC] px-1.5 py-0.5 text-[11px] text-[#116644]">{a.label}</span>}
                          {a.isDefault && <span className="shrink-0 text-[11px] text-[#5F6B64]">Default</span>}
                        </span>
                        <span className="mt-1 block text-[#5C6B62] break-words">
                          {[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}, {a.city}, {a.state} {a.postalCode}
                        </span>
                        <span className="mt-1 block text-[#5C6B62]">{formatPhone(a.phoneE164)}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {showForm && (
                  <AddressForm
                    cancellable={addresses.length > 0}
                    onCancel={() => setShowForm(false)}
                    onSaved={(a) => {
                      setAddresses((list) => [...(list ?? []).map((x) => (a.isDefault ? { ...x, isDefault: false } : x)), a]);
                      setAddressId(a.id);
                      setShippingCode(undefined);
                      setShowForm(false);
                    }}
                    makeDefault={addresses.length === 0}
                    submitLabel="Save and deliver here"
                  />
                )}
              </div>
            )}
          </section>

          {/* Shipping */}
          {addressId && shipping && (
            <section className={card} aria-labelledby="ship-h">
              <h2 id="ship-h" className="font-heading text-[18px] font-bold text-[#113322] mb-4">2. Delivery method</h2>
              {shipping.status === "UNAVAILABLE" ? (
                <p className="text-[14px] text-[#B42318]">We don’t deliver to this PIN code yet. Please choose another address.</p>
              ) : shipping.status === "INVALID_METHOD" && shipping.options.length === 0 ? (
                <p role="alert" className="text-[14px] text-[#B42318]">The delivery method you chose is no longer offered. Please try again in a moment.</p>
              ) : shipping.status === "FREE" ? (
                <p className="text-[14px] text-[#5C6B62]">Standard delivery — <span className="font-semibold text-[#116644]">Free</span></p>
              ) : (
                <fieldset className="space-y-2">
                  <legend className="sr-only">Choose a delivery method</legend>
                  {shipping.status === "INVALID_METHOD" && (
                    <p role="alert" className="text-[14px] text-[#B42318]">
                      The delivery method you chose is no longer offered. Please pick one of these.
                    </p>
                  )}
                  {shipping.options.map((o) => (
                    <label
                      key={o.code}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-4 text-[14px] ${
                        o.code === shippingCode ? "border-[#116644] bg-[#F1F8F4]" : "border-[#E1E8E4]"
                      }`}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <input type="radio" name="shipping" checked={o.code === shippingCode} onChange={() => setShippingCode(o.code)} className="accent-[#116644]" />
                        <span className="min-w-0">
                          <span className="block font-semibold text-[#113322]">{o.name}</span>
                          <span className="block text-[#5F6B64] text-[13px]">
                            {o.etaMinDays === o.etaMaxDays ? `${o.etaMinDays}` : `${o.etaMinDays}–${o.etaMaxDays}`} business days
                          </span>
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold text-[#113322]">{o.free || o.feeMinor === 0 ? "Free" : formatPaise(o.feeMinor)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </section>
          )}

          <section className={card}>
            <h2 className="font-heading text-[18px] font-bold text-[#113322] mb-2">{addressId && shipping ? "3." : "2."} Payment</h2>
            <p className="text-[14px] text-[#5C6B62] flex items-start gap-2">
              <ShieldCheck className="w-5 h-5 text-[#116644] shrink-0" aria-hidden />
              You’ll pay securely with UPI, card, net banking or wallet in Razorpay’s window. Your card details never reach our servers.
            </p>
          </section>
        </div>

        {/* Summary */}
        <aside className={`${card} space-y-4 lg:sticky lg:top-24 min-w-0`} aria-labelledby="sum-h">
          <h2 id="sum-h" className="font-heading text-[18px] font-bold text-[#113322]">Order summary</h2>
          {/* A cart action that failed here (e.g. removing the coupon) must be visible on this page too. */}
          <CartErrorBanner />
          <ul className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
            {cart.items.map((i) => (
              <li key={i.variantId} className="flex gap-3 min-w-0">
                <div className="relative w-14 h-14 shrink-0 overflow-hidden rounded-lg bg-[#F2F4F3]">
                  <ProductImage src={i.imageUrl} alt={i.productName} sizes="56px" className="object-cover" />
                </div>
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-semibold text-[#113322] line-clamp-2">{i.productName}</p>
                  <p className="text-[#5F6B64]">{[i.variantName, `Qty ${i.quantity}`].filter(Boolean).join(" · ")}</p>
                  {!i.purchasable && <p className="text-[#B42318]">Not available in this quantity</p>}
                </div>
                <span className="shrink-0 text-[13px] font-semibold text-[#113322]">{formatPaise(i.lineTotalMinor)}</span>
              </li>
            ))}
          </ul>

          <dl className="space-y-2 border-t border-[#E1E8E4] pt-4 text-[14px]" aria-busy={quoting}>
            {(() => {
              const t = quote?.totals ?? cart.totals;
              return (
                <>
                  <Row label="Subtotal" value={formatPaise(t.subtotalMinor)} />
                  {t.discountMinor > 0 && (
                    <Row label={`Discount${quote?.coupon ? ` (${quote.coupon.code})` : ""}`} value={`− ${formatPaise(t.discountMinor)}`} accent />
                  )}
                  {cart.coupon && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => void removeCoupon()}
                        disabled={cartPending.has("coupon")}
                        className="text-[12px] font-semibold text-[#116644] hover:underline disabled:opacity-50"
                      >
                        Remove coupon {cart.coupon.code}
                      </button>
                    </div>
                  )}
                  <Row label="Shipping" value={quote ? (t.shippingMinor === 0 ? "Free" : formatPaise(t.shippingMinor)) : "Select address"} />
                  <div className="flex justify-between border-t border-[#E1E8E4] pt-3 text-[16px] font-bold text-[#113322]">
                    <dt>Total</dt>
                    <dd>{formatPaise(t.totalMinor)}</dd>
                  </div>
                  <p className="text-[12px] text-[#5F6B64]">
                    Includes GST {formatPaise(t.gstIncludedMinor)}
                    {quote && (quote.tax.supply === "INTRA_STATE" ? " (CGST + SGST)" : " (IGST)")}
                  </p>
                </>
              );
            })()}
          </dl>

          {quoteError && <p role="alert" className="text-[13px] text-[#B42318]">{quoteError}</p>}
          {blocked && (
            <p role="alert" className="flex gap-2 text-[13px] text-[#B42318]">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {itemsBlocked ? (
                <span>
                  Some items are unavailable. <Link href="/cart" className="font-semibold underline">Update your cart</Link> to continue.
                </span>
              ) : deliveryBlocked ? (
                <span>We don’t deliver to this address yet. Choose or add another address to continue.</span>
              ) : totalTooLow ? (
                <span>The total must be at least {formatPaise(quote!.minimumPayableMinor)} to pay online. Add an item or remove the coupon.</span>
              ) : (
                <span>This order can’t be placed yet. Please review the details above.</span>
              )}
            </p>
          )}
          {placeError && <p role="alert" className="text-[13px] text-[#B42318]">{placeError}</p>}

          <button
            type="button"
            onClick={placeAndPay}
            disabled={!canPlace}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#116644] py-3.5 text-[15px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {placing ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <Lock className="w-4 h-4" aria-hidden />}
            {placing ? "Processing…" : quote ? `Place order & pay ${formatPaise(quote.totals.totalMinor)}` : "Place order & pay"}
          </button>
          <p className="text-center text-[12px] text-[#5F6B64]">
            Stock is held for {quote?.paymentWindowMinutes ?? 30} minutes after you place the order while you complete payment.
          </p>
        </aside>
      </div>
    </Shell>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-[#5C6B62]">
      <dt className="min-w-0 truncate">{label}</dt>
      <dd className={accent ? "text-[#116644] font-semibold" : "text-[#113322]"}>{value}</dd>
    </div>
  );
}
