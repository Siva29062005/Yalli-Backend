import { invoiceLines } from './tax-documents.js';
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
import type { OrderStatus } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
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
      include: {
        items: true,
        history: { orderBy: { createdAt: 'asc' } },
        returns: {
          select: { orderItemId: true, quantity: true, status: true },
        },
      },
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
    const outcome = await this.prisma.$transaction(async (tx) => {
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

      // A customer cancelling their own paid order gets their money back automatically, and the order is cancelled now.
      // A STAFF cancel is a refund a person asked for: it only REQUESTS the cancellation. A second person approves the
      // refund (four-eyes); the order is cancelled and restocked when that refund is processed (RefundService.recompute),
      // and a rejected or failed refund leaves the order where it was. Otherwise staff could ship goods off-system and
      // refund the order at once.
      const byStaff = actor.type === 'ADMIN';
      if (byStaff && !actor.id)
        throw new Error('A staff cancellation must name the staff member');
      const cancelReason = `Order cancelled: ${reason}`.slice(0, 200);
      // One refund key per cancel ATTEMPT: an earlier cancel refund that was REJECTED or FAILED must not be returned
      // again by the idempotency lookup (that would cancel without refunding). An open or processed one is reused.
      const earlier = await tx.refund.findMany({
        where: { orderId, idempotencyKey: { startsWith: `cancel:${orderId}` } },
        select: { idempotencyKey: true, status: true },
      });
      const live = earlier.find(
        (r) => r.status !== 'REJECTED' && r.status !== 'FAILED',
      );
      const idempotencyKey =
        live?.idempotencyKey ??
        (earlier.length === 0
          ? `cancel:${orderId}`
          : `cancel:${orderId}:${earlier.length}`);
      if (byStaff) {
        await this.refunds.requestInTx(tx, {
          paymentId: payment.id,
          kind: 'ADMIN',
          amountMinor: payment.capturedMinor - payment.refundedMinor,
          reason: cancelReason,
          requestedById: actor.id ?? null,
          autoApprove: false,
          idempotencyKey,
        });
        return { refund: null, pendingApproval: true };
      }
      // Refund FIRST (claims the refundable amount, moves the order to REFUND_PENDING), then cancel the fulfilment.
      const refund = await this.refunds.requestInTx(tx, {
        paymentId: payment.id,
        kind: 'CUSTOMER_CANCEL',
        amountMinor: payment.capturedMinor - payment.refundedMinor,
        reason: cancelReason,
        requestedById: null,
        autoApprove: true,
        idempotencyKey,
      });
      if (
        refund.status !== 'APPROVED' &&
        refund.status !== 'PROCESSING' &&
        refund.status !== 'PROCESSED'
      )
        throw new ConflictException({
          message:
            'This order cannot be cancelled automatically. Please contact support.',
          code: 'ORDER_NOT_CANCELLABLE',
        });
      await this.lifecycle.markPaidOrderCancelledInTx(
        tx,
        orderId,
        reason,
        this.inventory,
      );
      return { refund, pendingApproval: false };
    });
    await this.audit.record({
      action: AuditAction.OrderCancelled,
      outcome: 'SUCCESS',
      actorId: actor.id ?? null,
      ...ctx,
      resourceType: 'order',
      resourceId: orderId,
      // A staff cancel of a paid order is only requested here: it completes when finance's approved refund is processed.
      metadata: {
        reason,
        by: actor.type,
        ...(outcome?.pendingApproval ? { pendingRefundApproval: true } : {}),
      },
    });
    if (outcome?.refund?.status === 'APPROVED')
      await this.refunds.execute(outcome.refund.id).catch(() => undefined);
  }

  // ----------------------------------------------------------------------------- invoice

  /** GST tax invoice data (JSON). Available once the order has been paid. */
  async invoice(principal: AuthPrincipal, orderId: string) {
    return this.invoiceWhere({ id: orderId, userId: principal.userId });
  }

  /** Staff copy of an order's invoice (same document the customer gets). */
  async adminInvoice(orderId: string) {
    return this.invoiceWhere({ id: orderId });
  }

  private async invoiceWhere(where: Prisma.OrderWhereInput) {
    const o = await this.prisma.order.findFirst({
      where,
      include: { items: true },
    });
    if (!o || !o.paidAt) throw new NotFoundException('Invoice not available');
    const intra =
      o.shipState.trim().toLowerCase() ===
      this.sellerState.trim().toLowerCase();
    return {
      invoiceNumber: o.invoiceNumber!, // set with paidAt (orders_invoice_paid_chk)
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
      // Goods first, then the delivery charge per GST rate (composite supply: taxed with the goods it carries).
      lines: invoiceLines(o.items, o.shippingMinor),
      totals: {
        subtotalMinor: o.subtotalMinor,
        discountMinor: o.discountMinor,
        shippingMinor: o.shippingMinor,
        // GST is included in every amount, delivery too: the taxable value is the total without it.
        taxableValueMinor: o.totalMinor - o.gstIncludedMinor,
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

  /** Support's view of one customer's recent orders and return requests (newest first, at most 20 of each). */
  async adminCustomerHistory(userId: string) {
    const [orders, returns] = await Promise.all([
      this.prisma.order.findMany({
        where: { userId },
        orderBy: { placedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          placedAt: true,
          totalMinor: true,
        },
      }),
      this.prisma.returnRequest.findMany({
        where: { order: { userId } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          status: true,
          quantity: true,
          reason: true,
          createdAt: true,
          order: { select: { id: true, orderNumber: true } },
          item: { select: { productName: true } },
        },
      }),
    ]);
    return { orders, returns };
  }

  /** The customer an order number belongs to (support finds a caller by the number on their invoice). */
  async ownerOfOrderNumber(orderNumber: string): Promise<string | null> {
    const o = await this.prisma.order.findUnique({
      where: { orderNumber },
      select: { userId: true },
    });
    return o?.userId ?? null;
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
      // Defence in depth: a cancelled order (its stock already back on the shelf) is never fulfilled.
      if (order.cancelledAt)
        throw new ConflictException({
          message: 'This order was cancelled',
          code: 'INVALID_ORDER_TRANSITION',
        });
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
    return (await this.customersWhoKept(productId, [userId])).has(userId);
  }

  /**
   * Of `userIds`, the customers who received `productId` in a delivered order and did not send every unit back for a
   * refund (a REFUNDED return): the basis of "verified purchase". One query for a whole page of reviews.
   */
  async customersWhoKept(
    productId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT DISTINCT o.user_id::text AS user_id
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ${productId}::uuid
        AND o.user_id IN (${Prisma.join(userIds.map((u) => Prisma.sql`${u}::uuid`))})
        AND o.delivered_at IS NOT NULL
        AND oi.quantity > COALESCE((
          SELECT SUM(r.quantity) FROM return_requests r
          WHERE r.order_item_id = oi.id AND r.status = 'REFUNDED'), 0)`;
    return new Set(rows.map((r) => r.user_id));
  }
}
