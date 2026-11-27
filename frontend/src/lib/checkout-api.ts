import { ApiError } from './http';
import { customerSession } from './customer-session';

/** Must match `INDIAN_STATES` in the backend customer schema. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
] as const;

export interface SavedAddress {
  id: string;
  label: string | null;
  fullName: string;
  phoneE164: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  postalCode: string;
  isDefault: boolean;
}

export interface AddressInput {
  label?: string;
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  state: string;
  postalCode: string;
  isDefault?: boolean;
}

export interface ShippingOption {
  code: string;
  name: string;
  feeMinor: number;
  free: boolean;
  etaMinDays: number;
  etaMaxDays: number;
}

export interface Quote {
  purchasable: boolean;
  shipping: {
    status: 'FREE' | 'UNAVAILABLE' | 'CHOICE_REQUIRED' | 'INVALID_METHOD' | 'SELECTED';
    selected: string | null;
    options: ShippingOption[];
  };
  problems: { variantId: string; issue: string }[];
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    shippingMinor: number;
    gstIncludedMinor: number;
    totalMinor: number;
    currency: string;
  };
  tax: { supply: 'INTRA_STATE' | 'INTER_STATE'; cgstMinor?: number; sgstMinor?: number; igstMinor?: number };
  coupon: { code: string; discountMinor: number } | null;
}

export type OrderStatus =
  | 'CREATED' | 'INVENTORY_RESERVED' | 'PAYMENT_PENDING' | 'PAYMENT_FAILED' | 'PAID' | 'PROCESSING'
  | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUND_PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED'
  | 'RETURN_REQUESTED' | 'RETURN_APPROVED' | 'RETURNED';

export interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  paidAt: string | null;
  paymentExpiresAt: string | null;
  cancellable: boolean;
  currency: string;
  totals: Quote['totals'] extends infer T ? Omit<T, 'currency'> : never;
  couponCode: string | null;
  shippingAddress: {
    name: string; phone: string; line1: string; line2: string | null; landmark: string | null;
    city: string; state: string; postalCode: string; country: string;
  };
  shippingMethod: { code: string; name: string } | null;
  items: {
    id: string; sku: string; productName: string; variantName: string | null; imageUrl: string | null;
    quantity: number; unitPriceMinor: number; lineDiscountMinor: number; lineTotalMinor: number;
  }[];
}

export const AWAITING_PAYMENT: OrderStatus[] = ['CREATED', 'INVENTORY_RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'];
export const PAID_STATUSES: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const checkoutApi = {
  addresses: () => customerSession.request<SavedAddress[]>('/me/addresses'),
  createAddress: (input: AddressInput) => customerSession.request<SavedAddress>('/me/addresses', json(input)),
  quote: (addressId: string, shippingMethodCode?: string) =>
    customerSession.request<Quote>('/checkout/quote', json({ addressId, shippingMethodCode })),
  placeOrder: (body: { addressId: string; expectedTotalMinor: number; shippingMethodCode?: string }, key: string) =>
    customerSession.request<CustomerOrder>('/checkout/orders', { ...json(body), headers: { 'Idempotency-Key': key } }),
  order: (id: string) => customerSession.request<CustomerOrder>(`/orders/${encodeURIComponent(id)}`),
  cancel: (id: string) =>
    customerSession.request<CustomerOrder>(`/orders/${encodeURIComponent(id)}/cancel`, json({ reason: 'Cancelled by customer' })),
};

/** One key per distinct request body: retries of the same submission reuse it, a changed request gets a new one. */
export function idempotencyKeys() {
  const keys = new Map<string, string>();
  return (body: unknown) => {
    const sig = JSON.stringify(body);
    let k = keys.get(sig);
    if (!k) {
      k = crypto.randomUUID();
      keys.set(sig, k);
    }
    return k;
  };
}

// ------------------------------------------------------------------------------------------- payment

interface PaymentStart {
  keyId: string;
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  orderNumber: string;
  prefill: { name?: string; email?: string; contact?: string };
}

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (r: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise: Promise<void> | null = null;

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = RAZORPAY_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      s.remove();
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.body.appendChild(s);
  });
  return scriptPromise;
}

export type PaymentResult =
  | { kind: 'paid'; order: CustomerOrder }
  | { kind: 'pending' } // provider will confirm via webhook; poll status
  | { kind: 'dismissed' }
  | { kind: 'failed'; message: string };

/**
 * Opens Razorpay's hosted checkout. Card/UPI data never touches our code. The browser's success callback is only
 * a hint: the backend verifies the signature AND asks Razorpay before marking the order paid.
 */
/**
 * A NEW key for every Pay click. Reusing one key per order made the server replay the first answer for 24 hours, so a
 * Pay click after the order was cancelled or expired still opened the payment window. A double click is still safe:
 * the server allows one live payment per order.
 */
export const payAttemptKey = (orderId: string) => `pay-${orderId}-${crypto.randomUUID()}`;

export async function payForOrder(orderId: string, key: string): Promise<PaymentResult> {
  const start = await customerSession.request<PaymentStart>(`/orders/${encodeURIComponent(orderId)}/payments`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
  });
  await loadRazorpay();
  if (!window.Razorpay) return { kind: 'failed', message: 'The payment window could not be opened.' };

  return new Promise<PaymentResult>((resolve) => {
    let settled = false;
    const done = (r: PaymentResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let lastFailure: string | null = null;
    const rzp = new window.Razorpay!({
      key: start.keyId,
      order_id: start.providerOrderId,
      amount: start.amountMinor,
      currency: start.currency,
      name: 'Yalli',
      description: `Order ${start.orderNumber}`,
      prefill: start.prefill,
      theme: { color: '#116644' },
      handler: async (r: RazorpayResponse) => {
        try {
          const res = await customerSession.request<{ paid: boolean; order: CustomerOrder }>(
            `/orders/${encodeURIComponent(orderId)}/payments/confirm`,
            json(r),
          );
          done(res.paid ? { kind: 'paid', order: res.order } : { kind: 'pending' });
        } catch {
          // The webhook is the source of truth; the order page polls for it.
          done({ kind: 'pending' });
        }
      },
      modal: {
        ondismiss: () => done(lastFailure ? { kind: 'failed', message: lastFailure } : { kind: 'dismissed' }),
      },
    });
    rzp.on('payment.failed', (r) => {
      lastFailure = r.error?.description || 'The payment was declined. You can try again.';
    });
    rzp.open();
  });
}

export function checkoutErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NOT_CONFIGURED' || e.status === 503) return 'Online payment is temporarily unavailable. Your order is saved; please try again shortly.';
    return e.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}

export function formatPhone(e164: string) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
