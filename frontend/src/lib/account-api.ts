import { customerSession, type CustomerProfile } from './customer-session';
import type { AddressInput, CustomerOrder, OrderStatus, SavedAddress } from './checkout-api';
import type { ProductSummary } from './catalog-api';

/** Shapes returned by the customer account endpoints (`/me/*`, `/orders`, `/returns`, `/auth/sessions`, `/auth/mfa`). */

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  totals: CustomerOrder['totals'];
  itemCount: number;
  items: { productName: string; imageUrl: string | null; quantity: number }[];
  cancellable: boolean;
}

export interface Shipment {
  carrier: string | null;
  trackingNumber: string | null;
  status: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  events: { status: string; location: string | null; note: string | null; occurredAt: string }[];
}

export interface Invoice {
  invoiceNumber: string;
  invoiceDate: string;
  orderNumber: string;
  taxInvoice: boolean;
  seller: { name: string; state: string; gstin: string | null };
  buyer: { name: string; email: string };
  placeOfSupply: string;
  supply: 'INTRA_STATE' | 'INTER_STATE';
  currency: string;
  lines: {
    description: string; sku: string; hsn: string | null; quantity: number; unitPriceMinor: number;
    discountMinor: number; taxableValueMinor: number; gstRateBps: number;
    cgstMinor: number; sgstMinor: number; igstMinor: number; lineTotalMinor: number;
  }[];
  totals: Record<string, number>;
}

export const RETURN_REASONS = {
  DEAD_ON_ARRIVAL: 'Arrived damaged / not working',
  FAULTY: 'Stopped working (faulty)',
  ORDER_ERROR: 'I ordered by mistake',
  WRONG_ITEM: 'Wrong item delivered',
  OTHER: 'Other',
} as const;
export type ReturnReason = keyof typeof RETURN_REASONS;

export interface ReturnRequest {
  id: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  opened: boolean;
  status: string;
  decisionNote: string | null;
  createdAt: string;
}

export interface MyReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  moderationNote: string | null;
  createdAt: string;
  updatedAt: string;
  product: { slug: string; name: string };
}

export interface DeviceSession {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export type WishlistItem = ProductSummary & { addedAt: string };

/** Largest page the API allows. */
export const ACCOUNT_PAGE_SIZE = 20;

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const id = encodeURIComponent;
const page = (p: number, size = ACCOUNT_PAGE_SIZE) => `?page=${p}&pageSize=${size}`;

export const accountApi = {
  updateProfile: (body: { firstName?: string; lastName?: string; newsletterSubscribed?: boolean }) =>
    customerSession.request<Pick<CustomerProfile, 'firstName' | 'lastName' | 'newsletterSubscribed'>>('/me', send('PATCH', body)),

  addresses: () => customerSession.request<SavedAddress[]>('/me/addresses'),
  createAddress: (body: AddressInput) => customerSession.request<SavedAddress>('/me/addresses', send('POST', body)),
  updateAddress: (addressId: string, body: Partial<AddressInput>) =>
    customerSession.request<SavedAddress>(`/me/addresses/${id(addressId)}`, send('PATCH', body)),
  setDefaultAddress: (addressId: string) =>
    customerSession.request<SavedAddress>(`/me/addresses/${id(addressId)}/default`, send('PUT')),
  removeAddress: (addressId: string) => customerSession.request<null>(`/me/addresses/${id(addressId)}`, send('DELETE')),

  orders: (p: number) => customerSession.request<OrderListItem[]>(`/orders${page(p)}`),
  order: (orderId: string) => customerSession.request<CustomerOrder>(`/orders/${id(orderId)}`),
  tracking: (orderId: string) => customerSession.request<{ shipment: Shipment | null }>(`/orders/${id(orderId)}/tracking`),
  invoice: (orderId: string) => customerSession.request<Invoice>(`/orders/${id(orderId)}/invoice`),
  cancelOrder: (orderId: string, reason: string) =>
    customerSession.request<CustomerOrder>(`/orders/${id(orderId)}/cancel`, send('POST', { reason })),

  returns: (p: number) => customerSession.request<ReturnRequest[]>(`/returns${page(p)}`),
  requestReturn: (
    orderId: string,
    body: { orderItemId: string; quantity: number; reason: ReturnReason; opened: boolean; details?: string },
  ) => customerSession.request<ReturnRequest>(`/orders/${id(orderId)}/returns`, send('POST', body)),

  reviews: (p: number) => customerSession.request<MyReview[]>(`/me/reviews${page(p)}`),
  updateReview: (reviewId: string, body: { rating?: number; title?: string | null; body?: string }) =>
    customerSession.request<MyReview>(`/me/reviews/${id(reviewId)}`, send('PATCH', body)),
  removeReview: (reviewId: string) => customerSession.request<null>(`/me/reviews/${id(reviewId)}`, send('DELETE')),

  wishlist: (p: number, size = ACCOUNT_PAGE_SIZE) => customerSession.request<WishlistItem[]>(`/me/wishlist${page(p, size)}`),
  saveToWishlist: (slug: string) => customerSession.request<{ saved: true }>(`/me/wishlist/${id(slug)}`, send('PUT')),
  removeFromWishlist: (slug: string) => customerSession.request<null>(`/me/wishlist/${id(slug)}`, send('DELETE')),

  sessions: () => customerSession.request<DeviceSession[]>('/auth/sessions'),
  revokeSession: (sessionId: string) => customerSession.request<null>(`/auth/sessions/${id(sessionId)}`, send('DELETE')),

  mfaEnroll: (password: string) =>
    customerSession.request<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', send('POST', { password })),
  mfaConfirm: (code: string) => customerSession.request<{ recoveryCodes: string[] }>('/auth/mfa/confirm', send('POST', { code })),
  mfaDisable: (body: { password: string; code?: string; recoveryCode?: string }) =>
    customerSession.request<null>('/auth/mfa/disable', send('POST', body)),
  mfaRegenerate: (code: string) =>
    customerSession.request<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes/regenerate', send('POST', { code })),
};

/** Customer-facing wording for order statuses. */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  CREATED: 'Awaiting payment',
  INVENTORY_RESERVED: 'Awaiting payment',
  PAYMENT_PENDING: 'Awaiting payment',
  PAYMENT_FAILED: 'Payment failed',
  PAID: 'Confirmed',
  PROCESSING: 'Packing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUND_PENDING: 'Refund in progress',
  PARTIALLY_REFUNDED: 'Partially refunded',
  REFUNDED: 'Refunded',
  RETURN_REQUESTED: 'Return requested',
  RETURN_APPROVED: 'Return approved',
  RETURNED: 'Returned',
};

export function statusTone(s: OrderStatus): string {
  if (s === 'DELIVERED' || s === 'PAID' || s === 'PROCESSING' || s === 'SHIPPED') return 'bg-[#E0EFE5] text-[#116644]';
  if (s === 'CANCELLED' || s === 'PAYMENT_FAILED') return 'bg-red-50 text-red-700';
  return 'bg-amber-50 text-amber-800';
}

/** Rough device description from a user-agent string (display only). */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
