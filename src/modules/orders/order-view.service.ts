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
};

@Injectable()
export class OrderViewService {
  private readonly mediaBase: string;

  constructor(config: ConfigService<Env, true>) {
    this.mediaBase = config
      .get('MEDIA_BASE_URL', { infer: true })
      .replace(/\/$/, '');
  }

  /** Customer-facing representation: explicit allow-list (no internal ids of payments, no actor ids). */
  customer(o: OrderWithItems) {
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
      })),
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
