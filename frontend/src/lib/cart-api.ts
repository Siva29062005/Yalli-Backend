import { ApiError, requestApi } from './http';
import { customerSession } from './customer-session';

/** Shape returned by every `/cart` endpoint. Prices are always computed by the server. */
export interface CartLine {
  variantId: string;
  sku: string;
  productId: string;
  productSlug: string;
  productName: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPriceMinor: number;
  compareAtMinor: number | null;
  lineSubtotalMinor: number;
  lineDiscountMinor: number;
  lineTotalMinor: number;
  purchasable: boolean;
  issue: 'UNAVAILABLE' | 'INSUFFICIENT_STOCK' | null;
  maxQuantity: number;
}

export interface CartView {
  cartToken?: string;
  items: CartLine[];
  itemCount: number;
  coupon: { code: string; discountMinor: number } | null;
  couponError: string | null;
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    shippingMinor: number;
    gstIncludedMinor: number;
    totalMinor: number;
    currency: string;
  };
}

export const EMPTY_CART: CartView = {
  items: [],
  itemCount: 0,
  coupon: null,
  couponError: null,
  totals: { subtotalMinor: 0, discountMinor: 0, shippingMinor: 0, gstIncludedMinor: 0, totalMinor: 0, currency: 'INR' },
};

const TOKEN_KEY = 'yalli_cart_token';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export const guestToken = {
  get(): string | null {
    if (typeof window === 'undefined') return null;
    const t = localStorage.getItem(TOKEN_KEY);
    if (t && !TOKEN_FORMAT.test(t)) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return t;
  },
  set(t: string) {
    localStorage.setItem(TOKEN_KEY, t);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/**
 * Signed-in customers use their bearer session; guests use the opaque X-Cart-Token the server issues on first add.
 * A stale/expired guest token simply yields an empty cart, so it is dropped.
 */
export async function cartRequest(signedIn: boolean, endpoint: string, options: RequestInit = {}): Promise<CartView> {
  if (signedIn) return customerSession.request<CartView>(endpoint, options);
  const token = guestToken.get();
  const view = await requestApi<CartView>(endpoint, {
    ...options,
    headers: { ...Object.fromEntries(new Headers(options.headers).entries()), ...(token ? { 'X-Cart-Token': token } : {}) },
  });
  if (view.cartToken) guestToken.set(view.cartToken);
  return view;
}

export async function mergeGuestCart(): Promise<CartView | null> {
  const token = guestToken.get();
  if (!token) return null;
  try {
    return await customerSession.request<CartView>('/cart/merge', {
      method: 'POST',
      headers: { 'X-Cart-Token': token },
    });
  } finally {
    // Merged or unusable either way: the guest cart is gone after merge.
    guestToken.clear();
  }
}

export function cartErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong with your cart. Please try again.';
}
