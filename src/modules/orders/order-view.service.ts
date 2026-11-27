import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import type {
  Order,
  OrderItem,
  OrderStatusHistory,
} from '../../generated/prisma/client.js';
import { UNPAID_CANCELLABLE, PAID_CANCELLABLE } from './order-state-machine.js';

export type OrderWithItems = Order & {
  items: OrderItem[];
  history?: OrderStatusHistory[];
  /** When present, the view says what can still be returned (`returnableUntil`, `returnableQuantity`). */
  returns?: { orderItemId: string; quantity: number; status: string }[];
};

/** Returns that count against what can still be returned (same rule as ReturnService). */
const ACTIVE_RETURN = ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED'];

@Injectable()
export class OrderViewService {
  private readonly mediaBase: string;
  private readonly returnWindowDays: number;

  constructor(config: ConfigService<Env, true>) {
    this.mediaBase = config
      .get('MEDIA_BASE_URL', { infer: true })
      .replace(/\/$/, '');
    this.returnWindowDays = config.get('RETURN_WINDOW_DAYS', { infer: true });
  }

  /** Customer-facing representation: explicit allow-list (no internal ids of payments, no actor ids). */
  customer(o: OrderWithItems, now = new Date()) {
    // A return can be asked for while the order is DELIVERED and inside the window (ReturnService enforces the same).
    const returnableUntil =
      o.status === 'DELIVERED' && o.deliveredAt
        ? new Date(o.deliveredAt.getTime() + this.returnWindowDays * 86_400_000)
        : null;
    const canReturn =
      returnableUntil !== null &&
      returnableUntil > now &&
      o.returns !== undefined;
    const returned = new Map<string, number>();
    for (const r of o.returns ?? [])
      if (ACTIVE_RETURN.includes(r.status))
        returned.set(
          r.orderItemId,
          (returned.get(r.orderItemId) ?? 0) + r.quantity,
        );
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      placedAt: o.placedAt,
      paidAt: o.paidAt,
      shippedAt: o.shippedAt,
      deliveredAt: o.deliveredAt,
      cancelledAt: o.cancelledAt,
      paymentExpiresAt: [
        'INVENTORY_RESERVED',
        'PAYMENT_PENDING',
        'PAYMENT_FAILED',
      ].includes(o.status)
        ? o.paymentExpiresAt
        : null,
      cancellable: [...UNPAID_CANCELLABLE, ...PAID_CANCELLABLE].includes(
        o.status,
      ),
      currency: o.currency,
      totals: {
        subtotalMinor: o.subtotalMinor,
        discountMinor: o.discountMinor,
        shippingMinor: o.shippingMinor,
        gstIncludedMinor: o.gstIncludedMinor,
        totalMinor: o.totalMinor,
      },
      couponCode: o.couponCode,
      shippingAddress: {
        name: o.shipName,
        phone: o.shipPhone,
        line1: o.shipLine1,
        line2: o.shipLine2,
        landmark: o.shipLandmark,
        city: o.shipCity,
        state: o.shipState,
        postalCode: o.shipPostalCode,
        country: o.shipCountry,
      },
      shippingMethod: o.shippingMethodCode
        ? { code: o.shippingMethodCode, name: o.shippingMethodName }
        : null,
      tracking: o.trackingNumber
        ? { carrier: o.trackingCarrier, number: o.trackingNumber }
        : null,
      items: o.items.map((i) => ({
        id: i.id,
        sku: i.sku,
        productName: i.productName,
        variantName: i.variantName,
        imageUrl: i.imageKey ? `${this.mediaBase}/${i.imageKey}` : null,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        compareAtMinor: i.compareAtMinor,
        lineDiscountMinor: i.lineDiscountMinor,
        lineTotalMinor: i.lineTotalMinor,
        gstIncludedMinor: i.gstIncludedMinor,
        ...(o.returns !== undefined
          ? {
              returnableQuantity: canReturn
                ? Math.max(0, i.quantity - (returned.get(i.id) ?? 0))
                : 0,
            }
          : {}),
      })),
      ...(o.returns !== undefined
        ? { returnableUntil: canReturn ? returnableUntil : null }
        : {}),
      ...(o.history
        ? {
            timeline: o.history.map((h) => ({
              status: h.toStatus,
              at: h.createdAt,
              reason:
                h.actorType === 'USER' || h.actorType === 'SYSTEM'
                  ? h.reason
                  : null,
            })),
          }
        : {}),
    };
  }
}
