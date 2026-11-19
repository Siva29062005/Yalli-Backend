'use client';

import { Minus, Plus } from 'lucide-react';
import type { CartLine } from '@/lib/cart-api';
import { useCart } from '@/components/CartProvider';

/** Quantity stepper bound to the server cart. Limits come from the server (`maxQuantity`). */
export function QuantityStepper({ line, compact = false }: { line: CartLine; compact?: boolean }) {
  const { pending, setQuantity } = useCart();
  const busy = pending.has(line.variantId);
  const pad = compact ? 'px-2 py-1' : 'px-3 py-1.5';
  const max = line.issue === 'UNAVAILABLE' ? 0 : line.maxQuantity;
  return (
    <div
      className={`flex items-center overflow-hidden rounded-lg border border-[#E6EAE7] bg-white ${busy ? 'opacity-60' : ''}`}
      aria-busy={busy}
    >
      <button
        type="button"
        onClick={() => setQuantity(line.variantId, line.quantity - 1)}
        disabled={busy}
        aria-label={line.quantity === 1 ? `Remove ${line.productName}` : `Decrease quantity of ${line.productName}`}
        className={`${pad} text-[#113322] hover:bg-[#F5F6F5] disabled:cursor-not-allowed`}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className={`${pad} min-w-8 text-center text-[13px] font-bold text-[#113322]`} aria-live="polite">
        {line.quantity}
      </span>
      <button
        type="button"
        onClick={() => setQuantity(line.variantId, line.quantity + 1)}
        disabled={busy || line.quantity >= max}
        aria-label={`Increase quantity of ${line.productName}`}
        className={`${pad} text-[#113322] hover:bg-[#F5F6F5] disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function LineIssue({ line }: { line: CartLine }) {
  if (!line.issue) return null;
  const text =
    line.issue === 'UNAVAILABLE'
      ? 'No longer available — remove it to continue.'
      : line.maxQuantity > 0
        ? `Only ${line.maxQuantity} left — reduce the quantity to continue.`
        : 'Out of stock — remove it to continue.';
  return (
    <p role="alert" className="mt-1 text-[12px] font-medium text-red-600">
      {text}
    </p>
  );
}

export function CartErrorBanner() {
  const { error, clearError } = useCart();
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
      <span className="min-w-0">{error}</span>
      <button type="button" onClick={clearError} className="shrink-0 font-semibold hover:underline">
        Dismiss
      </button>
    </div>
  );
}
