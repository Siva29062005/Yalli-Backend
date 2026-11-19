export interface Category {
  id: string;
  name: string;
  slug: string;
  iconName?: string;
  description?: string;
  productCount?: number;
  featured?: boolean;
}

export interface ProductVariant {
  id: string;
  sku: string;
  name?: string;
  priceMinor: number; // in paise
  salePriceMinor?: number | null; // in paise
  saleStart?: string | null;
  saleEnd?: string | null;
  weightGrams?: number;
  optionValues?: Record<string, string>;
  inStock: boolean;
  stockCount: number;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  headline?: string;
  summary?: string;
  descriptionHtml?: string;
  brand: string;
  category: string;
  categorySlug: string;
  images: string[];
  variants: ProductVariant[];
  basePriceMinor: number;
  salePriceMinor?: number | null;
  gstRateBps: number; // e.g. 1800 for 18%, 1200 for 12%
  rating: number;
  reviewCount: number;
  badge?: "BEST SELLER" | "UP TO 35% OFF" | "NEW" | "SALE";
  features?: string[];
  specs?: Record<string, string>;
  isYalliOriginal?: boolean;
}

export interface CartItem {
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  image: string;
  variantLabel: string;
  priceMinor: number;
  regularPriceMinor: number;
  quantity: number;
}

export interface Coupon {
  code: string;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  value: number; // percentage (e.g. 10) or paise (e.g. 10000)
  minCartValueMinor: number;
  maxDiscountMinor?: number;
  description: string;
}

export interface Address {
  id: string;
  name: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  pincode: string;
  isDefault?: boolean;
  type?: "HOME" | "WORK" | "OTHER";
}

export interface OrderTrackingEvent {
  status: string;
  date: string;
  title: string;
  description: string;
  completed: boolean;
  current?: boolean;
}

export interface Order {
  id: string;
  orderNumber: string; // e.g. YL26-000123
  date: string;
  totalMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  status:
    | "CREATED"
    | "INVENTORY_RESERVED"
    | "PAYMENT_PENDING"
    | "PAID"
    | "PROCESSING"
    | "SHIPPED"
    | "DELIVERED"
    | "CANCELLED"
    | "REFUND_PENDING"
    | "REFUNDED"
    | "RETURN_REQUESTED"
    | "RETURN_APPROVED"
    | "RETURNED";
  paymentMethod: "UPI" | "CARD" | "NETBANKING" | "WALLET";
  items: CartItem[];
  shippingAddress: Address;
  carrier?: string;
  trackingNumber?: string;
  trackingEvents?: OrderTrackingEvent[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: "CUSTOMER" | "ADMIN" | "SUPER_ADMIN" | "PRODUCT_MGR" | "SUPPORT";
  mfaEnabled: boolean;
  avatarUrl?: string;
}
