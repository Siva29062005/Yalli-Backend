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
import type {
  Prisma,
  ReturnReason,
  ReturnStatus,
} from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { RefundService } from '../refunds/refund.service.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';

@Injectable()
export class ReturnService {
  private readonly windowDays: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly inventory: InventoryService,
    private readonly refunds: RefundService,
    private readonly audit: AuditService,
  ) {
    this.windowDays = config.get('RETURN_WINDOW_DAYS', { infer: true });
  }

  /** Mirrors the storefront's RMA form: order, product, quantity, reason, opened?, details. */
  async request(
    principal: AuthPrincipal,
    orderId: string,
    input: {
      orderItemId: string;
      quantity: number;
      reason: ReturnReason;
      opened: boolean;
      details?: string | undefined;
    },
    ctx: RequestContext,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      const own = await tx.order.findFirst({
        where: { id: orderId, userId: principal.userId },
        select: { id: true },
      });
      if (!own) throw new NotFoundException('Order not found');
      const order = await this.lifecycle.lock(tx, orderId);
      if (order.status !== 'DELIVERED' || !order.deliveredAt)
        throw new ConflictException({
          message: 'Only delivered orders can be returned',
          code: 'ORDER_NOT_RETURNABLE',
        });
      if (
        Date.now() - order.deliveredAt.getTime() >
        this.windowDays * 86_400_000
      ) {
        throw new ConflictException({
          message: `Returns are accepted within ${this.windowDays} days of delivery`,
          code: 'RETURN_WINDOW_CLOSED',
        });
      }
      const item = await tx.orderItem.findFirst({
        where: { id: input.orderItemId, orderId },
      });
      if (!item) throw new NotFoundException('Item not found on this order');
      const alreadyReturned = await tx.returnRequest.aggregate({
        where: {
          orderItemId: item.id,
          status: { in: ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED'] },
        },
        _sum: { quantity: true },
      });
      if (input.quantity + (alreadyReturned._sum.quantity ?? 0) > item.quantity)
        throw new ConflictException({
          message: 'You cannot return more units than you bought',
          code: 'RETURN_QUANTITY_EXCEEDED',
        });
      let request;
      try {
        request = await tx.returnRequest.create({
          data: {
            orderId,
            orderItemId: item.id,
            userId: principal.userId,
            quantity: input.quantity,
            reason: input.reason,
            opened: input.opened,
            details: input.details ?? null,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002')
          throw new ConflictException({
            message: 'This order already has an open return request',
            code: ErrorCode.Conflict,
          });
        throw err;
      }
      await this.lifecycle.transition(
        tx,
        orderId,
        'RETURN_REQUESTED',
        { type: 'USER', id: principal.userId },
        {
          reason: 'return requested',
          event: {
            type: 'return.requested',
            payload: { returnId: request.id },
          },
        },
      );
      return request;
    });
    await this.audit.record({
      action: AuditAction.ReturnRequested,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'return',
      resourceId: created.id,
      metadata: { orderId, reason: input.reason },
    });
    return created;
  }

  async listOwn(principal: AuthPrincipal, q: PaginationInput) {
    const where = { userId: principal.userId };
    const [items, total] = await Promise.all([
      this.prisma.returnRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          orderId: true,
          orderItemId: true,
          quantity: true,
          reason: true,
          opened: true,
          status: true,
          decisionNote: true,
          createdAt: true,
          // What the customer recognises: the order number and the item as it was bought (immutable snapshots).
          order: { select: { orderNumber: true } },
          item: { select: { productName: true, variantName: true } },
        },
      }),
      this.prisma.returnRequest.count({ where }),
    ]);
    return paginated(
      items.map(({ order, item, ...r }) => ({
        ...r,
        orderNumber: order.orderNumber,
        productName: item.productName,
        variantName: item.variantName,
      })),
      total,
      q,
    );
  }

  /** Staff list, newest first; optionally one status and/or one order (the order page links here). */
  async adminList(
    q: PaginationInput & {
      status?: ReturnStatus | undefined;
      orderId?: string | undefined;
    },
  ) {
    const where: Prisma.ReturnRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.orderId ? { orderId: q.orderId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.returnRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          order: { select: { orderNumber: true } },
          item: { select: { productName: true, sku: true } },
        },
      }),
      this.prisma.returnRequest.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  async decide(
    actorId: string,
    returnId: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string | undefined,
    ctx: RequestContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.returnRequest.findUnique({ where: { id: returnId } });
      if (!r) throw new NotFoundException('Return not found');
      await this.lifecycle.lock(tx, r.orderId);
      const moved = await tx.returnRequest.updateMany({
        where: { id: returnId, status: 'REQUESTED' },
        data: {
          status: decision,
          decidedById: actorId,
          decisionNote: note ?? null,
        },
      });
      if (moved.count !== 1)
        throw new ConflictException({
          message: 'This return was already decided',
          code: ErrorCode.Conflict,
        });
      await this.lifecycle.transition(
        tx,
        r.orderId,
        decision === 'APPROVED' ? 'RETURN_APPROVED' : 'DELIVERED',
        { type: 'ADMIN', id: actorId },
        {
          reason: `return ${decision.toLowerCase()}`,
          event: { type: 'return.decided', payload: { returnId, decision } },
        },
      );
    });
    await this.audit.record({
      action: AuditAction.ReturnDecided,
      outcome: 'SUCCESS',
      actorId,
      ...ctx,
      resourceType: 'return',
      resourceId: returnId,
      metadata: { decision },
    });
  }

  /**
   * Goods are back. Unopened items go back on sale; a refund REQUEST (default: this item's share of what was paid) is
   * raised for a DIFFERENT approver to release.
   */
  async markReceived(
    actorId: string,
    returnId: string,
    refundAmountMinor: number | undefined,
    ctx: RequestContext,
  ) {
    const refund = await this.prisma.$transaction(async (tx) => {
      const r = await tx.returnRequest.findUnique({
        where: { id: returnId },
        include: { item: true },
      });
      if (!r) throw new NotFoundException('Return not found');
      await this.lifecycle.lock(tx, r.orderId);
      const moved = await tx.returnRequest.updateMany({
        where: { id: returnId, status: 'APPROVED' },
        data: { status: 'RECEIVED' },
      });
      if (moved.count !== 1)
        throw new ConflictException({
          message: 'This return is not awaiting receipt',
          code: ErrorCode.Conflict,
        });
      await this.lifecycle.transition(
        tx,
        r.orderId,
        'RETURNED',
        { type: 'ADMIN', id: actorId },
        { reason: 'goods received' },
      );
      if (!r.opened)
        await this.inventory.restockInTx(
          tx,
          r.item.variantId,
          r.quantity,
          { referenceType: 'RETURN', referenceId: r.id },
          'unopened return restocked',
        );
      const payment = await tx.payment.findFirst({
        where: {
          orderId: r.orderId,
          status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'] },
        },
      });
      if (!payment)
        throw new ConflictException({
          message: 'No captured payment to refund',
          code: 'NOTHING_TO_REFUND',
        });
      // This item's share of what the customer actually paid (after any coupon), rounded down.
      const share = Math.floor(
        (r.item.lineTotalMinor * r.quantity) / r.item.quantity,
      );
      return this.refunds.requestInTx(tx, {
        paymentId: payment.id,
        kind: 'RETURN',
        amountMinor: refundAmountMinor ?? share,
        reason: `Return ${r.id.slice(0, 8)}: ${r.reason}`,
        requestedById: actorId,
        autoApprove: false,
        idempotencyKey: `return:${r.id}`,
        returnRequestId: r.id,
      });
    });
    await this.audit.record({
      action: AuditAction.RefundRequested,
      outcome: 'SUCCESS',
      actorId,
      ...ctx,
      resourceType: 'refund',
      resourceId: refund.id,
      metadata: { returnId, amountMinor: refund.amountMinor },
    });
    return refund;
  }
}
