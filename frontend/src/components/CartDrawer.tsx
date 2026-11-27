'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X, Trash2, ArrowRight, ShoppingBag } from 'lucide-react';
import { useStore } from '@/lib/store';
import { formatPaise } from '@/lib/formatters';
import { cartUnits, useCart } from '@/components/CartProvider';
import { ProductImage } from '@/components/ProductImage';
import { CartErrorBanner, LineIssue, QuantityStepper } from '@/components/CartLineControls';

export function CartDrawer() {
  const isOpen = useStore((s) => s.isCartDrawerOpen);
  const setOpen = useStore((s) => s.setCartDrawerOpen);
  const { cart, status, pending, removeItem, reload } = useCart();
  const blocked = cart.items.some((i) => !i.purchasable);
  const pathname = usePathname();
  // Following a link (checkout, a product) closes the drawer; it must not reappear on the next page.
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, setOpen]);

  if (!isOpen) return null;
  const close = () => setOpen(false);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden" role="dialog" aria-modal="true" aria-label="Your cart">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-xs" onClick={close} />
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div className="flex w-screen max-w-md flex-col bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-[#E6EAE7] p-5">
            <div className="flex items-center gap-2">
              <ShoppingBag className="h-5 w-5 text-[#116644]" />
              <h2 className="font-heading text-lg font-bold text-[#113322]">Your Cart ({cartUnits(cart)})</h2>
            </div>
            <button
              onClick={close}
              type="button"
              aria-label="Close cart"
              className="rounded-full p-1 text-[#5F6B64] hover:bg-[#F5F6F5] hover:text-[#113322]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            <CartErrorBanner />
            {status === 'loading' ? (
              <p className="py-12 text-center text-[14px] text-[#5F6B64]">Loading your cart…</p>
            ) : status === 'error' ? (
              <div className="space-y-3 py-12 text-center">
                <p className="text-[14px] text-[#5F6B64]">We couldn&apos;t load your cart.</p>
                <button type="button" onClick={() => reload()} className="font-semibold text-[#116644] hover:underline">
                  Try again
                </button>
              </div>
            ) : cart.items.length === 0 ? (
              <div className="space-y-3 py-12 text-center">
                <p className="text-[14px] text-[#5F6B64]">Your cart is taking a breather.</p>
                <Link
                  href="/catalog"
                  onClick={close}
                  className="inline-block rounded-lg bg-[#FF9900] px-5 py-2.5 text-[13px] font-semibold text-[#113322] transition hover:bg-[#e68a00]"
                >
                  Explore collection →
                </Link>
              </div>
            ) : (
              cart.items.map((item) => (
                <div key={item.variantId} className="flex items-start gap-3 border-b border-[#F0F2F1] pb-4">
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-[#F7F8F7]">
                    <ProductImage src={item.imageUrl} alt={item.productName} sizes="64px" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/products/${item.productSlug}`}
                      onClick={close}
                      className="line-clamp-1 text-[14px] font-medium text-[#113322] hover:text-[#116644]"
                    >
                      {item.productName}
                    </Link>
                    <p className="truncate text-[12px] text-[#5F6B64]">{item.variantName || item.sku}</p>
                    <LineIssue line={item} />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <QuantityStepper line={item} compact />
                      <div className="flex items-center gap-3">
                        <span className="text-[14px] font-bold text-[#A65500]">
                          {formatPaise(item.purchasable ? item.lineTotalMinor : item.unitPriceMinor * item.quantity)}
                        </span>
                        <button
                          onClick={() => removeItem(item.variantId)}
                          disabled={pending.has(item.variantId)}
                          type="button"
                          aria-label={`Remove ${item.productName}`}
                          className="text-[#5F6B64] hover:text-red-500 disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {status === 'ready' && cart.items.length > 0 && (
            <div className="space-y-3 border-t border-[#E6EAE7] bg-[#FAFAFA] p-5">
              {cart.totals.discountMinor > 0 && (
                <div className="flex justify-between rounded-md bg-[#EEFFEE] px-3 py-1.5 text-[13px] font-medium text-[#116644]">
                  <span>Coupon savings</span>
                  <span>− {formatPaise(cart.totals.discountMinor)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-[#113322]">
                <span>Total (incl. GST)</span>
                <span className="text-lg text-[#A65500]">{formatPaise(cart.totals.totalMinor)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <Link
                  href="/cart"
                  onClick={close}
                  className="rounded-lg border border-[#116644] py-2.5 text-center text-[13px] font-semibold text-[#116644] transition hover:bg-[#116644]/5"
                >
                  View full cart
                </Link>
                {blocked ? (
                  <span className="flex items-center justify-center rounded-lg bg-[#E6EAE7] py-2.5 text-[13px] font-semibold text-[#5F6B64]">
                    Fix cart to checkout
                  </span>
                ) : (
                  <Link
                    href="/checkout"
                    onClick={close}
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-[#FF9900] py-2.5 text-[13px] font-semibold text-[#113322] shadow-xs transition hover:bg-[#e68a00]"
                  >
                    <span>Checkout</span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                )}
              </div>
              <p className="text-center text-[11px] text-[#5F6B64]">Delivery fee is shown at checkout · Returns within 7 days of delivery</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
