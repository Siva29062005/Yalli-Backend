"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ShieldCheck, FileText, ArrowRight } from "lucide-react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ProductImage } from "@/components/ProductImage";
import { cartUnits, useCart } from "@/components/CartProvider";
import { CartErrorBanner, LineIssue, QuantityStepper } from "@/components/CartLineControls";
import { formatPaise } from "@/lib/formatters";

export default function CartPage() {
  const { cart, status, pending, removeItem, applyCoupon, removeCoupon, reload } = useCart();
  const [couponCode, setCouponCode] = useState("");
  const [couponError, setCouponError] = useState("");
  const couponBusy = pending.has("coupon");
  const blocked = cart.items.some((i) => !i.purchasable);
  const { totals } = cart;
  // Count every line (including ones needing attention) so the heading matches what's listed.
  const lineCount = cartUnits(cart);

  const handleApplyCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = couponCode.trim();
    if (code.length < 3) {
      setCouponError("Enter a valid coupon code");
      return;
    }
    setCouponError("");
    const error = await applyCoupon(code);
    if (error) setCouponError(error);
    else setCouponCode("");
  };

  return (
    <>
      <AnnouncementBar />
      <Header />

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 md:px-8 lg:px-12 py-6 space-y-6">
        <nav aria-label="Breadcrumb" className="text-[13px] text-[#5F6B64] flex items-center gap-2">
          <Link href="/" className="hover:text-[#116644]">Home</Link>
          <span>/</span>
          <span className="text-[#113322] font-medium">Your cart</span>
        </nav>

        {status === "loading" ? (
          <div className="py-24 text-center text-[#5F6B64]" aria-busy="true">Loading your cart…</div>
        ) : status === "error" ? (
          <div className="py-24 text-center space-y-3">
            <p className="text-[#4A5550]">We couldn&apos;t load your cart.</p>
            <button type="button" onClick={() => reload()} className="font-semibold text-[#116644] hover:underline">
              Try again
            </button>
          </div>
        ) : cart.items.length === 0 ? (
          <div className="py-12 space-y-8 text-center max-w-xl mx-auto">
            <h1 className="font-heading text-[32px] md:text-[36px] font-bold text-[#113322]">
              A little room for something lovely.
            </h1>

            {/* Illustration Card */}
            <div
              className="relative aspect-[16/10] rounded-3xl overflow-hidden border border-[#E6EAE7] bg-[#EEFFEE]/40 shadow-xs mx-auto"
              style={{ position: "relative" }}
            >
              <Image
                src="https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80"
                alt="Empty Cart"
                fill
                sizes="(max-width: 768px) 100vw, 500px"
                className="object-cover"
              />
            </div>

            <div className="space-y-2">
              <h2 className="font-heading text-[22px] font-bold text-[#113322]">
                Your cart is taking a breather.
              </h2>
              <p className="text-[14px] text-[#5F6B64]">
                Fill it with everyday favourites for a happier home.
              </p>
            </div>

            <div className="pt-2 space-y-3">
              <Link
                href="/catalog"
                className="inline-block bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-semibold text-[15px] px-8 py-3.5 rounded-xl transition shadow-xs"
              >
                Explore the collection →
              </Link>
              <div>
                <Link
                  href="/help"
                  className="text-[13px] text-[#116644] hover:underline font-medium"
                >
                  Need a hand? We&apos;re here for you.
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            <div>
              <h1 className="font-heading text-[32px] md:text-[36px] font-bold text-[#113322]">
                Your cart, full of good things.
              </h1>
              <p className="text-[14px] text-[#5F6B64]">
                {lineCount} {lineCount === 1 ? "item" : "items"} you&apos;ll love having at home.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-8 space-y-6 min-w-0">
                <CartErrorBanner />
                <div className="bg-white rounded-3xl p-4 sm:p-6 md:p-8 border border-[#E6EAE7] space-y-6">
                  {cart.items.map((item, index) => (
                    <div
                      key={item.variantId}
                      className={`flex gap-4 sm:gap-5 pb-6 ${index < cart.items.length - 1 ? "border-b border-[#F0F2F1]" : ""} ${item.purchasable ? "" : "opacity-80"}`}
                    >
                      <div className="relative w-20 h-20 sm:w-28 sm:h-28 rounded-2xl bg-[#F7F8F7] overflow-hidden shrink-0 border border-[#E6EAE7]">
                        <ProductImage src={item.imageUrl} alt={item.productName} sizes="(max-width: 640px) 80px, 112px" />
                      </div>

                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div className="flex flex-wrap justify-between items-start gap-x-4 gap-y-1">
                          <div className="min-w-0">
                            <Link
                              href={`/products/${item.productSlug}`}
                              className="font-heading text-[16px] font-bold text-[#113322] hover:text-[#116644] break-words"
                            >
                              {item.productName}
                            </Link>
                            <p className="text-[13px] text-[#5F6B64] mt-0.5">{item.variantName || item.sku}</p>
                            <LineIssue line={item} />
                          </div>
                          <div className="text-right">
                            <span className="font-heading text-[18px] font-bold text-[#A65500] block">
                              {formatPaise(item.purchasable ? item.lineSubtotalMinor : item.unitPriceMinor * item.quantity)}
                            </span>
                            {item.compareAtMinor !== null && item.compareAtMinor > item.unitPriceMinor && (
                              <span className="text-[13px] text-[#5F6B64] line-through">
                                {formatPaise(item.compareAtMinor * item.quantity)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
                          <QuantityStepper line={item} />
                          <button
                            onClick={() => removeItem(item.variantId)}
                            disabled={pending.has(item.variantId)}
                            className="text-[13px] text-[#5F6B64] hover:text-red-500 font-medium disabled:opacity-40"
                            type="button"
                          >
                            Remove ✕
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <Link href="/catalog" className="inline-block text-[14px] text-[#116644] font-semibold hover:underline">
                  ← Continue shopping
                </Link>

                {/* Trust Strip matching Figma Screen 05 */}
                <div className="bg-[#EEFFEE]/40 rounded-2xl p-5 border border-[#E0EFE5] flex flex-wrap items-center justify-between gap-4 text-[13px] text-[#4A5550]">
                  <span className="font-semibold text-[#113322]">
                    Good for your kitchen & home. Easy on your mind.
                  </span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="w-4 h-4 text-[#116644]" />
                      Secure payment
                    </span>
                    <span aria-hidden className="hidden sm:inline">·</span>
                    <span className="flex items-center gap-1">
                      <FileText className="w-4 h-4 text-[#116644]" />
                      GST invoice included
                    </span>
                    <span aria-hidden className="hidden sm:inline">·</span>
                    <span>Returns within 7 days of delivery</span>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-4 space-y-4 min-w-0">
                <div className="bg-white rounded-3xl p-6 md:p-8 border border-[#E6EAE7] space-y-5 shadow-xs">
                  <h2 className="font-heading text-[20px] font-bold text-[#113322]">Order summary</h2>

                  <div className="space-y-3 text-[14px]">
                    <div className="flex justify-between text-[#4A5550]">
                      <span>Subtotal</span>
                      <span>{formatPaise(totals.subtotalMinor)}</span>
                    </div>
                    {totals.discountMinor > 0 && (
                      <div className="flex justify-between text-[#116644] font-medium">
                        <span>Coupon discount</span>
                        <span>− {formatPaise(totals.discountMinor)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-[#4A5550]">
                      <span>Shipping</span>
                      <span>Calculated at checkout</span>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-[#E6EAE7] space-y-1">
                    <div className="flex justify-between items-baseline gap-2">
                      <span className="font-heading text-[18px] font-bold text-[#113322]">Total</span>
                      <span className="font-heading text-[24px] font-bold text-[#113322]">{formatPaise(totals.totalMinor)}</span>
                    </div>
                    <p className="text-[12px] text-[#5F6B64]">Includes {formatPaise(totals.gstIncludedMinor)} GST</p>
                  </div>

                  <div className="pt-2">
                    {cart.coupon && !cart.couponError ? (
                      <div className="bg-[#EEFFEE] border border-[#116644]/30 rounded-xl p-3 flex items-center justify-between gap-3 text-[13px]">
                        <div className="min-w-0">
                          <span className="font-bold text-[#116644] block break-all">{cart.coupon.code} applied</span>
                          <span className="text-[12px] text-[#4A5550]">You save {formatPaise(cart.coupon.discountMinor)}</span>
                        </div>
                        <button
                          onClick={() => removeCoupon()}
                          disabled={couponBusy}
                          className="shrink-0 text-[12px] text-red-500 font-semibold hover:underline disabled:opacity-40"
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleApplyCoupon} className="space-y-2" noValidate>
                        {cart.coupon && cart.couponError && (
                          <p role="alert" className="text-[12px] text-red-500">
                            {cart.coupon.code} no longer applies to this cart.{" "}
                            <button type="button" onClick={() => removeCoupon()} className="font-semibold underline">
                              Remove it
                            </button>
                          </p>
                        )}
                        <label htmlFor="coupon" className="text-[12px] font-semibold text-[#113322] block">Have a coupon?</label>
                        <div className="flex gap-2">
                          <input
                            id="coupon"
                            type="text"
                            maxLength={40}
                            autoComplete="off"
                            placeholder="Enter code"
                            value={couponCode}
                            onChange={(e) => setCouponCode(e.target.value)}
                            aria-invalid={!!couponError}
                            className="min-w-0 flex-1 bg-[#F5F6F5] text-[13px] px-3.5 py-2 rounded-xl border border-transparent focus:border-[#116644] focus:bg-white outline-none uppercase"
                          />
                          <button
                            type="submit"
                            disabled={couponBusy}
                            className="shrink-0 border border-[#116644] text-[#116644] hover:bg-[#116644] hover:text-white font-semibold text-[13px] px-4 py-2 rounded-xl transition disabled:opacity-50"
                          >
                            {couponBusy ? "Applying…" : "Apply"}
                          </button>
                        </div>
                        {couponError && <p role="alert" className="text-[12px] text-red-500">{couponError}</p>}
                      </form>
                    )}
                  </div>

                  {blocked ? (
                    <p role="alert" className="w-full rounded-xl bg-[#F5F6F5] py-3.5 px-4 text-center text-[13px] font-semibold text-[#5F6B64]">
                      Remove or update unavailable items to checkout
                    </p>
                  ) : (
                    <Link
                      href="/checkout"
                      className="w-full bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-bold text-[15px] py-3.5 px-6 rounded-xl flex items-center justify-center gap-2 transition shadow-xs"
                    >
                      <span>Proceed to Checkout</span>
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
