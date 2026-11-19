import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import {
  paginated,
  type PaginationInput,
} from '../../common/http/pagination.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { CouponService } from '../coupons/coupon.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { ShipmentStatusName } from '../shipping/shipping-rules.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { RefundService } from '../refunds/refund.service.js';
import {
  OrderLifecycleService,
  type Actor,
} from './order-lifecycle.service.js';
import { PAID_CANCELLABLE, UNPAID_CANCELLABLE } from './order-state-machine.js';
import { OrderViewService } from './order-view.service.js';

const FULFILMENT_FLOW: Record<
  'PROCESSING' | 'SHIPPED' | 'DELIVERED',
  { from: OrderStatus; event: string }
> = {
  PROCESSING: { from: 'PAID', event: 'order.processing' },
  SHIPPED: { from: 'PROCESSING', event: 'order.shipped' },
  DELIVERED: { from: 'SHIPPED', event: 'order.delivered' },
};

@Injectable()
export class OrderService {
  private readonly sellerName: string;
  private readonly sellerState: string;
  private readonly sellerGstin: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly inventory: InventoryService,
    private readonly coupons: CouponService,
    private readonly refunds: RefundService,
    private readonly views: OrderViewService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly shipping: ShippingService,
  ) {
    this.sellerName = config.get('SELLER_LEGAL_NAME', { infer: true });
    this.sellerState = config.get('SELLER_STATE', { infer: true });
    this.sellerGstin = config.get('SELLER_GSTIN', { infer: true });
  }

  // -------------------------------------------------------------------------- customer reads

  /** Ownership is part of EVERY query: someone else's order id is indistinguishable from a missing one (404). */
  async getOwn(principal: AuthPrincipal, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId: principal.userId },
      include: { items: true, history: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.views.customer(order);
  }

  async listOwn(principal: AuthPrincipal, q: PaginationInput) {
    const where = {
      userId: principal.userId,
      status: { not: 'CREATED' as const },
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { items: true },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginated(
      rows.map((o) => {
        const v = this.views.customer(o);
        return {
          id: v.id,
          orderNumber: v.orderNumber,
          status: v.status,
          placedAt: v.placedAt,
          totals: v.totals,
          itemCount: v.items.reduce((n, i) => n + i.quantity, 0),
          items: v.items.slice(0, 3).map((i) => ({
            productName: i.productName,
            imageUrl: i.imageUrl,
            quantity: i.quantity,
          })),
          cancellable: v.cancellable,
        };
      }),
      total,
      q,
    );
  }

  // ------------------------------------------------------------------------------- cancel

  /**
   * Customer (or admin) cancellation.
   *  - unpaid: the order is simply abandoned and stock/coupon are released;
   *  - paid, not shipped: stock goes back on the shelf and a FULL refund is raised automatically; the order is closed by the refund;
   *  - shipped or later: not cancellable (use a return).
   */
  async cancel(
    orderId: string,
    actor: Actor,
    reason: string,
    ctx: RequestContext,
    ownerId?: string,
  ): Promise<void> {
    if (ownerId) {
      const own = await this.prisma.order.findFirst({
        where: { id: orderId, userId: ownerId },
        select: { id: true },
      });
      if (!own) throw new NotFoundException('Order not found');
    }
    const refundToExecute = await this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lock(tx, orderId);
      if (order.status === 'CANCELLED') return null; // idempotent
      if (UNPAID_CANCELLABLE.includes(order.status)) {
        await this.lifecycle.cancelUnpaid(
          tx,
          orderId,
          actor,
          reason,
          this.inventory,
          this.coupons,
        );
        return null;
      }
      if (!PAID_CANCELLABLE.includes(order.status)) {
        throw new ConflictException({
          message: `An order that is ${order.status} cannot be cancelled. Request a return instead.`,
          code: 'ORDER_NOT_CANCELLABLE',
        });
      }
      const payment = await tx.payment.findFirst({
        where: {
          orderId,
          status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'] },
        },
      });
      if (!payment)
        throw new ConflictException({
          message: 'No captured payment found for this order',
          code: 'NOTHING_TO_REFUND',
        });

      // Goods go back on the shelf.
      for (const ref of [
        { referenceType: 'ORDER', referenceId: orderId },
        { referenceType: 'ORDER_LATE', referenceId: orderId },
      ]) {
        await this.inventory.restockCommittedInTx(
          tx,
          ref,
          'order cancelled after payment',
        );
      }
      const now = new Date();
      await tx.order.update({
        where: { id: orderId },
        data: {
          cancelledAt: now,
          cancelReason: reason.slice(0, 200),
          inventoryReleasedAt: now,
        },
      });
      const refund = await this.refunds.requestInTx(tx, {
        paymentId: payment.id,
        kind: 'CUSTOMER_CANCEL',
        amountMinor: payment.capturedMinor - payment.refundedMinor,
        reason: `Order cancelled: ${reason}`.slice(0, 200),
        requestedById: null,
        autoApprove: true,
        idempotencyKey: `cancel:${orderId}`,
      });
      // The refund request above already moved the order to REFUND_PENDING (and recorded it in the history).
      await this.outbox.add(tx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.cancelled',
        payload: {
          orderId,
          orderNumber: order.orderNumber,
          userId: order.userId,
          reason,
          paid: true,
        },
      });
      return refund;
    });
    await this.audit.record({
      action: AuditAction.OrderCancelled,
      outcome: 'SUCCESS',
      actorId: actor.id ?? null,
      ...ctx,
      resourceType: 'order',
      resourceId: orderId,
      metadata: { reason, by: actor.type },
    });
    if (refundToExecute)
      await this.refunds.execute(refundToExecute.id).catch(() => undefined);
  }

  // ----------------------------------------------------------------------------- invoice

  /** GST tax invoice data (JSON). Available once the order has been paid. */
  async invoice(principal: AuthPrincipal, orderId: string) {
    const o = await this.prisma.order.findFirst({
      where: { id: orderId, userId: principal.userId },
      include: { items: true },
    });
    if (!o || !o.paidAt) throw new NotFoundException('Invoice not available');
    const intra =
      o.shipState.trim().toLowerCase() ===
      this.sellerState.trim().toLowerCase();
    return {
      invoiceNumber: `INV-${o.orderNumber}`,
      invoiceDate: o.paidAt,
      orderNumber: o.orderNumber,
      taxInvoice: this.sellerGstin !== undefined, // not a valid tax invoice until the seller GSTIN is configured
      seller: {
        name: this.sellerName,
        state: this.sellerState,
        gstin: this.sellerGstin ?? null,
      },
      buyer: { name: o.shipName, email: o.contactEmail },
      placeOfSupply: o.shipState,
      supply: intra ? 'INTRA_STATE' : 'INTER_STATE',
      currency: o.currency,
      lines: o.items.map((i) => ({
        description:
          i.productName + (i.variantName ? ` (${i.variantName})` : ''),
        sku: i.sku,
        hsn: i.hsnCode,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        discountMinor: i.lineDiscountMinor,
        taxableValueMinor: i.lineTotalMinor - i.gstIncludedMinor,
        gstRateBps: i.gstRateBps,
        cgstMinor: i.cgstMinor,
        sgstMinor: i.sgstMinor,
        igstMinor: i.igstMinor,
        lineTotalMinor: i.lineTotalMinor,
      })),
      totals: {
        subtotalMinor: o.subtotalMinor,
        discountMinor: o.discountMinor,
        shippingMinor: o.shippingMinor,
        taxableValueMinor: o.totalMinor - o.shippingMinor - o.gstIncludedMinor,
        gstIncludedMinor: o.gstIncludedMinor,
        totalMinor: o.totalMinor,
      },
    };
  }

  // ----------------------------------------------------------------------------------- admin

  async adminList(
    q: PaginationInput & {
      status?: OrderStatus | undefined;
      q?: string | undefined;
    },
  ) {
    const where: Prisma.OrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { orderNumber: { contains: q.q, mode: 'insensitive' } },
              { contactEmail: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          placedAt: true,
          totalMinor: true,
          contactEmail: true,
          shipCity: true,
          shipState: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  async adminGet(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        history: { orderBy: { createdAt: 'asc' } },
        returns: true,
      },
    });
    if (!o) throw new NotFoundException('Order not found');
    return {
      ...this.views.customer(o),
      contactEmail: o.contactEmail,
      contactPhone: o.contactPhone,
      history: o.history.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        at: h.createdAt,
        actorType: h.actorType,
        actorId: h.actorId,
        reason: h.reason,
      })),
      returns: o.returns,
    };
  }

  async adminPayments(orderId: string) {
    return this.prisma.payment.findMany({
      where: { orderId },
      orderBy: { attempt: 'asc' },
      select: {
        id: true,
        provider: true,
        providerOrderId: true,
        providerPaymentId: true,
        status: true,
        amountMinor: true,
        capturedMinor: true,
        refundedMinor: true,
        attempt: true,
        method: true,
        failureCode: true,
        createdAt: true,
        capturedAt: true,
        events: {
          orderBy: { createdAt: 'asc' },
          select: {
            type: true,
            fromStatus: true,
            toStatus: true,
            source: true,
            createdAt: true,
          },
        },
        refunds: {
          select: {
            id: true,
            amountMinor: true,
            status: true,
            kind: true,
            createdAt: true,
            processedAt: true,
          },
        },
      },
    });
  }

  /** PAID -> PROCESSING -> SHIPPED -> DELIVERED. Anything out of sequence is refused by the state machine. */
  async advance(
    actorId: string,
    orderId: string,
    to: 'PROCESSING' | 'SHIPPED' | 'DELIVERED',
    input: {
      trackingCarrier?: string | undefined;
      trackingNumber?: string | undefined;
    },
    ctx: RequestContext,
  ) {
    const step = FULFILMENT_FLOW[to];
    if (to === 'SHIPPED' && !input.trackingNumber)
      throw new ConflictException({
        message: 'A tracking number is required to ship an order',
        code: ErrorCode.ValidationFailed,
      });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lock(tx, orderId);
      if (order.status !== step.from && order.status !== to)
        throw new ConflictException({
          message: `Order is ${order.status}; expected ${step.from}`,
          code: 'INVALID_ORDER_TRANSITION',
        });
      if (to === 'SHIPPED')
        await this.shipping.createShipmentInTx(
          tx,
          {
            orderId,
            carrier: input.trackingCarrier?.trim() || 'Other',
            trackingNumber: input.trackingNumber ?? '',
          },
          actorId,
        );
      if (to === 'DELIVERED' && order.status !== 'DELIVERED')
        await this.shipping.applyEventInTx(
          tx,
          orderId,
          { status: 'DELIVERED', note: 'Marked delivered' },
          actorId,
        );
      await this.lifecycle.transition(
        tx,
        orderId,
        to,
        { type: 'ADMIN', id: actorId },
        {
          reason: `marked ${to.toLowerCase()}`,
          extras: {
            ...(to === 'SHIPPED'
              ? {
                  shippedAt: now,
                  trackingCarrier: input.trackingCarrier ?? null,
                  trackingNumber: input.trackingNumber ?? null,
                }
              : {}),
            ...(to === 'DELIVERED' ? { deliveredAt: now } : {}),
          },
          event: { type: step.event },
        },
      );
    });
    await this.audit.record({
      action: AuditAction.OrderStatusChanged,
      outcome: 'SUCCESS',
      actorId,
      ...ctx,
      resourceType: 'order',
      resourceId: orderId,
      metadata: { to },
    });
    return this.adminGet(orderId);
  }

  /** Customer tracking view. Ownership is proven first: a foreign order id is a 404, exactly like a missing one. */
  async trackingOwn(principal: AuthPrincipal, orderId: string) {
    const own = await this.prisma.order.findFirst({
      where: { id: orderId, userId: principal.userId },
      select: { id: true },
    });
    if (!own) throw new NotFoundException('Order not found');
    return { shipment: await this.shipping.trackingFor(orderId) };
  }

  /** Admin tracking update for a SHIPPED order. DELIVERED also completes the order (and notifies the customer). */
  async addTrackingEvent(
    actorId: string,
    orderId: string,
    input: {
      status: ShipmentStatusName;
      location?: string | undefined;
      note?: string | undefined;
      occurredAt?: Date | undefined;
    },
    ctx: RequestContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lock(tx, orderId);
      if (order.status !== 'SHIPPED' && order.status !== 'DELIVERED')
        throw new ConflictException({
          message: `Order is ${order.status}; tracking applies to shipped orders`,
          code: 'INVALID_ORDER_TRANSITION',
        });
      const r = await this.shipping.applyEventInTx(tx, orderId, input, actorId);
      if (
        r.changed &&
        input.status === 'DELIVERED' &&
        order.status === 'SHIPPED'
      )
        await this.lifecycle.transition(
          tx,
          orderId,
          'DELIVERED',
          { type: 'ADMIN', id: actorId },
          {
            reason: 'delivered (tracking)',
            extras: { deliveredAt: input.occurredAt ?? new Date() },
            event: { type: 'order.delivered' },
          },
        );
    });
    await this.audit.record({
      action: AuditAction.ShipmentUpdated,
      outcome: 'SUCCESS',
      actorId,
      ...ctx,
      resourceType: 'order',
      resourceId: orderId,
      metadata: { status: input.status },
    });
    return this.trackingForAdmin(orderId);
  }

  async trackingForAdmin(orderId: string) {
    return { shipment: await this.shipping.trackingFor(orderId) };
  }

  /** True when the customer holds a DELIVERED order containing the product: the basis of a "verified purchase" review. */
  async hasReceivedProduct(
    userId: string,
    productId: string,
  ): Promise<boolean> {
    const hit = await this.prisma.orderItem.findFirst({
      where: { productId, order: { userId, deliveredAt: { not: null } } },
      select: { id: true },
    });
    return hit !== null;
  }
}
