import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type {
  OrderStatus,
  PaymentStatus,
  Prisma,
  Refund,
  RefundKind,
} from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrderLifecycleService } from '../orders/order-lifecycle.service.js';
import { PAID_CANCELLABLE, REFUNDABLE } from '../orders/order-state-machine.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  PaymentProvider,
  PaymentProviderError,
  type ProviderRefund,
} from '../payments/payment-provider.js';
import {
  assertPaymentTransition,
  MONEY_HELD_STATUSES,
} from '../payments/payment-state-machine.js';

type Tx = Prisma.TransactionClient;

export interface RefundRequest {
  paymentId: string;
  kind: RefundKind;
  amountMinor: number;
  reason: string;
  /** null = raised by the system (customer cancelling a paid order, late capture). */
  requestedById: string | null;
  autoApprove: boolean;
  idempotencyKey: string;
  returnRequestId?: string | undefined;
  /** A retry of this FAILED refund (refunds.retry_of_id, unique). */
  retryOfId?: string | undefined;
}

const OPEN: Refund['status'][] = ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING'];

/**
 * Refund safety, in layers:
 *  1. `payments.refunded_minor` is bumped by ONE conditional UPDATE (`... + x <= captured_minor`), so two concurrent
 *     requests can never refund more than was captured; a DB CHECK repeats the rule.
 *  2. Human-requested refunds need a DIFFERENT person with refunds.approve (application check + DB CHECK).
 *  3. Provider calls carry our unique `receipt`; an ambiguous failure (timeout) is resolved by looking the receipt up at
 *     the provider before anything is retried, so a refund is never sent twice.
 *  4. Every state change is audited, evented and visible in the payment's immutable event log.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly lifecycle: OrderLifecycleService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  // ------------------------------------------------------------------------------- request

  /** Joins the caller's transaction (so e.g. "cancel order" and "request refund" commit together). Idempotent per key. */
  async requestInTx(tx: Tx, input: RefundRequest): Promise<Refund> {
    // Only the system (a customer's own cancel, a late capture, an out-of-stock payment) may skip approval: a refund a
    // person asked for always needs someone else to approve it. Backed by refunds_human_approval_chk.
    if (input.autoApprove && input.requestedById !== null)
      throw new Error('A refund requested by a person cannot be auto-approved');
    const existing = await tx.refund.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return existing;
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1)
      throw new ConflictException({
        message: 'Refund amount must be a positive number of paise',
        code: ErrorCode.ValidationFailed,
      });

    // Lock order is always ORDER then PAYMENT (same as the payment webhook path), so the two can never deadlock.
    const pre = await tx.payment.findUnique({
      where: { id: input.paymentId },
      select: { orderId: true },
    });
    if (!pre) throw new NotFoundException('Payment not found');
    const order = await this.lifecycle.lock(tx, pre.orderId);
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: input.paymentId },
    });

    if (!MONEY_HELD_STATUSES.includes(payment.status))
      throw new ConflictException({
        message: 'There is no captured payment to refund',
        code: 'NOTHING_TO_REFUND',
      });
    if (order.status !== 'CANCELLED' && !REFUNDABLE.includes(order.status)) {
      throw new ConflictException({
        message: `An order that is ${order.status} cannot be refunded`,
        code: 'ORDER_NOT_REFUNDABLE',
      });
    }

    // Claim the refundable capacity atomically. Zero rows = it would exceed what was captured.
    const claimed = await tx.$executeRaw`
      UPDATE payments SET refunded_minor = refunded_minor + ${input.amountMinor}, updated_at = now()
      WHERE id = ${input.paymentId}::uuid AND refunded_minor + ${input.amountMinor} <= captured_minor`;
    if (claimed !== 1) {
      throw new ConflictException({
        message: `Refund exceeds the refundable balance (${payment.capturedMinor - payment.refundedMinor} paise left)`,
        code: 'REFUND_EXCEEDS_CAPTURED',
      });
    }

    const refund = await tx.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        returnRequestId: input.returnRequestId ?? null,
        kind: input.kind,
        amountMinor: input.amountMinor,
        reason: input.reason.slice(0, 200),
        status: input.autoApprove ? 'APPROVED' : 'PENDING_APPROVAL',
        requestedById: input.requestedById,
        receipt: `RF-${randomBytes(8).toString('hex')}`,
        idempotencyKey: input.idempotencyKey,
        retryOfId: input.retryOfId ?? null,
      },
    });
    await this.recompute(tx, order.id, payment.id);
    await this.outbox.add(tx, {
      aggregateType: 'refund',
      aggregateId: refund.id,
      eventType: input.autoApprove ? 'refund.approved' : 'refund.requested',
      payload: {
        refundId: refund.id,
        orderId: order.id,
        amountMinor: refund.amountMinor,
        kind: refund.kind,
      },
    });
    return refund;
  }

  // ------------------------------------------------------------------------------- decisions

  async approve(
    actor: AuthPrincipal,
    refundId: string,
    ctx: RequestContext,
  ): Promise<Refund> {
    const refund = await this.prisma.$transaction(async (tx) => {
      const r = await tx.refund.findUnique({ where: { id: refundId } });
      if (!r) throw new NotFoundException('Refund not found');
      if (r.requestedById === actor.userId) {
        throw new ForbiddenException({
          message:
            'A refund must be approved by someone other than the person who requested it',
          code: 'FOUR_EYES_REQUIRED',
        });
      }
      const moved = await tx.refund.updateMany({
        where: { id: refundId, status: 'PENDING_APPROVAL' },
        data: { status: 'APPROVED', approvedById: actor.userId },
      });
      if (moved.count !== 1)
        throw new ConflictException({
          message: 'This refund is no longer awaiting approval',
          code: ErrorCode.Conflict,
        });
      await this.outbox.add(tx, {
        aggregateType: 'refund',
        aggregateId: refundId,
        eventType: 'refund.approved',
        payload: {
          refundId,
          orderId: r.orderId,
          amountMinor: r.amountMinor,
          approvedById: actor.userId,
        },
      });
      return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    });
    await this.audit.record({
      action: AuditAction.RefundApproved,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'refund',
      resourceId: refundId,
      metadata: { amountMinor: refund.amountMinor, orderId: refund.orderId },
    });
    await this.execute(refundId); // best effort now; the worker retries if this fails
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /**
   * Retry of a FAILED refund (a bank or provider refused it): a NEW refund request for the same order, payment, kind,
   * amount and return, in the name of the staff member retrying. Like every refund a person asks for, a DIFFERENT
   * person must approve it. A failed cancel refund is retried under the next cancel key, so when the retry is processed
   * the cancellation completes (RefundService.recompute). One retry per failed refund (unique retry_of_id).
   */
  async retryFailed(
    actor: AuthPrincipal,
    failedId: string,
    ctx: RequestContext,
  ): Promise<Refund> {
    let retry: Refund;
    try {
      retry = await this.prisma.$transaction(async (tx) => {
        const failed = await tx.refund.findUnique({ where: { id: failedId } });
        if (!failed) throw new NotFoundException('Refund not found');
        const order = await this.lifecycle.lock(tx, failed.orderId); // ORDER first (requestInTx locks it again)
        const current = await tx.refund.findUniqueOrThrow({
          where: { id: failedId },
          include: { retriedBy: { select: { id: true } } },
        });
        if (current.status !== 'FAILED')
          throw new ConflictException({
            message: 'Only a failed refund can be retried',
            code: 'REFUND_NOT_FAILED',
          });
        if (current.retriedBy)
          throw new ConflictException({
            message: 'This refund was already retried',
            code: 'REFUND_ALREADY_RETRIED',
          });
        const cancelPrefix = `cancel:${current.orderId}`;
        const isCancel =
          current.idempotencyKey === cancelPrefix ||
          current.idempotencyKey.startsWith(`${cancelPrefix}:`);
        // A staff cancel whose refund failed left the order where it was, and it may have shipped since. Retrying the
        // CANCEL then would cancel (and restock) goods the customer already has: only while it is still cancellable.
        if (
          isCancel &&
          !order.cancelledAt &&
          !PAID_CANCELLABLE.includes(order.status)
        )
          throw new ConflictException({
            message: `This order is now ${order.status.toLowerCase().replaceAll('_', ' ')}, so it can no longer be cancelled: raise a refund for it instead`,
            code: 'ORDER_NOT_CANCELLABLE',
          });
        const idempotencyKey = isCancel
          ? `${cancelPrefix}:${await tx.refund.count({ where: { orderId: current.orderId, idempotencyKey: { startsWith: cancelPrefix } } })}`
          : `retry:${current.id}`;
        return this.requestInTx(tx, {
          paymentId: current.paymentId,
          kind: current.kind,
          amountMinor: current.amountMinor,
          // keeps the "Order cancelled: " prefix of a cancel refund (recompute reads the reason from it)
          reason: isCancel
            ? current.reason
            : `Retry of ${current.receipt}: ${current.reason}`,
          requestedById: actor.userId,
          autoApprove: false,
          idempotencyKey,
          returnRequestId: current.returnRequestId ?? undefined,
          retryOfId: current.id,
        });
      });
    } catch (err) {
      // two people retrying at the same moment: the unique retry_of_id decides
      if ((err as { code?: string }).code === 'P2002') {
        // retry_of_id: someone retried it at the same moment; any other unique key (two cancel attempts numbered
        // at once): a plain conflict, try again
        const where = JSON.stringify((err as { meta?: unknown }).meta ?? {});
        throw new ConflictException(
          /retry_?of_?id/i.test(where)
            ? {
                message: 'This refund was already retried',
                code: 'REFUND_ALREADY_RETRIED',
              }
            : {
                message:
                  'Another change to this order happened at the same moment; please try again',
                code: ErrorCode.Conflict,
              },
        );
      }
      throw err;
    }
    await this.audit.record({
      action: AuditAction.RefundRetried,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'refund',
      resourceId: retry.id,
      metadata: {
        retryOf: failedId,
        amountMinor: retry.amountMinor,
        orderId: retry.orderId,
      },
    });
    return retry;
  }

  async reject(
    actor: AuthPrincipal,
    refundId: string,
    reason: string,
    ctx: RequestContext,
  ): Promise<Refund> {
    const refund = await this.prisma.$transaction(async (tx) => {
      const r = await tx.refund.findUnique({ where: { id: refundId } });
      if (!r) throw new NotFoundException('Refund not found');
      // Lock order ORDER -> PAYMENT in every refund transaction (requestInTx, the payment webhook): never the reverse.
      await this.lifecycle.lock(tx, r.orderId);
      const moved = await tx.refund.updateMany({
        where: { id: refundId, status: 'PENDING_APPROVAL' },
        data: {
          status: 'REJECTED',
          rejectionReason: reason.slice(0, 200),
          approvedById: null,
        },
      });
      if (moved.count !== 1)
        throw new ConflictException({
          message: 'This refund is no longer awaiting approval',
          code: ErrorCode.Conflict,
        });
      await this.releaseCapacity(tx, r);
      await this.outbox.add(tx, {
        aggregateType: 'refund',
        aggregateId: refundId,
        eventType: 'refund.rejected',
        payload: { refundId, orderId: r.orderId },
      });
      return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    });
    await this.audit.record({
      action: AuditAction.RefundRejected,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'refund',
      resourceId: refundId,
      metadata: { reason },
    });
    return refund;
  }

  // ------------------------------------------------------------------------------ execution

  /** Sends an APPROVED refund to the provider. Safe to call repeatedly and from many instances. */
  async execute(refundId: string): Promise<void> {
    const claimed = await this.prisma.refund.updateMany({
      where: { id: refundId, status: 'APPROVED' },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count !== 1) return; // someone else has it, or it is already finished
    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!refund.payment.providerPaymentId) {
      await this.fail(refundId, 'The payment has no provider payment id');
      return;
    }
    try {
      const pr = await this.provider.createRefund({
        providerPaymentId: refund.payment.providerPaymentId,
        amountMinor: refund.amountMinor,
        receipt: refund.receipt,
        notes: { refundId, orderId: refund.orderId },
      });
      await this.applyProviderRefund(pr);
    } catch (err) {
      if (err instanceof PaymentProviderError && err.definitive) {
        await this.fail(
          refundId,
          `Rejected by the payment provider (${err.code ?? 'error'})`,
        );
      } else {
        // Outcome UNKNOWN: it may or may not have reached the provider. Stay PROCESSING; reconcile() resolves it by receipt.
        this.logger.warn(
          { refundId, err: (err as Error).message },
          'Refund outcome unknown; will reconcile',
        );
      }
    }
  }

  /** Marks a refund finished by the provider (immediate response or reconciliation). Idempotent. */
  async applyProviderRefund(
    pr: ProviderRefund,
  ): Promise<'processed' | 'failed' | 'pending' | 'unknown'> {
    const { result, mismatchRefundId } = await this.prisma.$transaction((tx) =>
      this.applyProviderRefundInTx(tx, pr),
    );
    await this.auditMismatch(mismatchRefundId);
    return result;
  }

  /**
   * The same inside the caller's transaction (the refund webhook records its event id in it). A provider amount that
   * differs from ours is NOT applied; the caller audits it AFTER the transaction (`auditMismatch`).
   */
  async applyProviderRefundInTx(
    tx: Tx,
    pr: ProviderRefund,
  ): Promise<{
    result: 'processed' | 'failed' | 'pending' | 'unknown';
    mismatchRefundId?: string;
  }> {
    const refund = await tx.refund.findFirst({
      where: {
        OR: [
          { providerRefundId: pr.id },
          { receipt: pr.receipt ?? '__none__' },
        ],
      },
    });
    if (!refund) return { result: 'unknown' };
    await this.lifecycle.lock(tx, refund.orderId); // ORDER first, before the refund and payment rows
    if (pr.amountMinor !== refund.amountMinor) {
      this.logger.error(
        {
          refundId: refund.id,
          expected: refund.amountMinor,
          got: pr.amountMinor,
        },
        'Provider refund amount mismatch',
      );
      return { result: 'unknown', mismatchRefundId: refund.id };
    }
    if (!refund.providerRefundId)
      await tx.refund.update({
        where: { id: refund.id },
        data: { providerRefundId: pr.id },
      });
    if (pr.status === 'processed') {
      await this.finishProcessed(tx, refund); // idempotent: a repeat is a no-op
      return { result: 'processed' };
    }
    if (pr.status === 'failed') {
      await this.finishFailed(
        tx,
        refund,
        'The payment provider reported the refund as failed',
      );
      return { result: 'failed' };
    }
    return { result: 'pending' };
  }

  /** Audits a provider refund amount mismatch (outside any transaction: never a second connection inside one). */
  async auditMismatch(refundId: string | undefined): Promise<void> {
    if (!refundId) return;
    await this.audit.record({
      action: AuditAction.RefundFailed,
      outcome: 'FAILURE',
      resourceType: 'refund',
      resourceId: refundId,
      metadata: { reason: 'amount_mismatch' },
    });
  }

  private async fail(refundId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
      });
      await this.lifecycle.lock(tx, refund.orderId);
      await this.finishFailed(tx, refund, reason);
    });
  }

  private async finishProcessed(tx: Tx, refund: Refund): Promise<boolean> {
    await this.lifecycle.lock(tx, refund.orderId); // re-entrant: callers normally hold it already
    const done = await tx.refund.updateMany({
      where: { id: refund.id, status: { in: ['PROCESSING', 'APPROVED'] } },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    if (done.count !== 1) return false; // already finished: idempotent
    if (refund.returnRequestId)
      await tx.returnRequest.updateMany({
        where: {
          id: refund.returnRequestId,
          status: { in: ['APPROVED', 'RECEIVED'] },
        },
        data: { status: 'REFUNDED' },
      });
    await this.recompute(tx, refund.orderId, refund.paymentId);
    await tx.paymentEvent.create({
      data: {
        paymentId: refund.paymentId,
        provider: this.provider.name,
        type: 'refund.processed',
        source: 'SYSTEM',
        data: { refundId: refund.id, amountMinor: refund.amountMinor },
      },
    });
    await this.outbox.add(tx, {
      aggregateType: 'refund',
      aggregateId: refund.id,
      eventType: 'refund.processed',
      payload: {
        refundId: refund.id,
        orderId: refund.orderId,
        amountMinor: refund.amountMinor,
      },
    });
    return true;
  }

  private async finishFailed(
    tx: Tx,
    refund: Refund,
    reason: string,
  ): Promise<void> {
    await this.lifecycle.lock(tx, refund.orderId); // re-entrant: callers normally hold it already
    const done = await tx.refund.updateMany({
      where: { id: refund.id, status: { in: ['PROCESSING', 'APPROVED'] } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 300) },
    });
    if (done.count !== 1) return;
    await this.releaseCapacity(tx, refund);
    await tx.paymentEvent.create({
      data: {
        paymentId: refund.paymentId,
        provider: this.provider.name,
        type: 'refund.failed',
        source: 'SYSTEM',
        data: { refundId: refund.id, reason: reason.slice(0, 200) },
      },
    });
    await this.outbox.add(tx, {
      aggregateType: 'refund',
      aggregateId: refund.id,
      eventType: 'refund.failed',
      payload: {
        refundId: refund.id,
        orderId: refund.orderId,
        amountMinor: refund.amountMinor,
      },
    });
  }

  /** A rejected/failed refund gives its reserved capacity back so another refund can be raised. */
  private async releaseCapacity(tx: Tx, refund: Refund): Promise<void> {
    await tx.$executeRaw`UPDATE payments SET refunded_minor = refunded_minor - ${refund.amountMinor}, updated_at = now() WHERE id = ${refund.paymentId}::uuid AND refunded_minor >= ${refund.amountMinor}`;
    await this.recompute(tx, refund.orderId, refund.paymentId);
  }

  // ----------------------------------------------------------------------- derived states

  /**
   * A partial refund must not stop the order: it goes back to where its fulfilment was, so a goodwill refund on a PAID
   * order can still ship and a delivered order can still have its other items returned. The amount refunded lives on
   * the payment (PARTIALLY_REFUNDED) and in the credit notes. Only an order with nothing left to fulfil or return
   * (every unit returned, delivery kept) is closed as PARTIALLY_REFUNDED.
   */
  private async statusAfterPartialRefund(
    tx: Tx,
    order: { id: string; statusBeforeRefund: OrderStatus | null },
  ): Promise<OrderStatus> {
    const before = order.statusBeforeRefund;
    if (before === 'PAID' || before === 'PROCESSING' || before === 'DELIVERED')
      return before;
    if (before !== 'RETURNED') return 'PARTIALLY_REFUNDED';
    // Sequential: one transaction is one connection.
    const bought = await tx.orderItem.aggregate({
      where: { orderId: order.id },
      _sum: { quantity: true },
    });
    const returned = await tx.returnRequest.aggregate({
      where: {
        orderId: order.id,
        status: { in: ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED'] },
      },
      _sum: { quantity: true },
    });
    return (bought._sum.quantity ?? 0) > (returned._sum.quantity ?? 0)
      ? 'DELIVERED'
      : 'PARTIALLY_REFUNDED';
  }

  /** Brings payment and order status in line with the refunds that exist (single source of truth: the refunds table). */
  async recompute(tx: Tx, orderId: string, paymentId: string): Promise<void> {
    const order = await this.lifecycle.lock(tx, orderId);
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    const refunds = await tx.refund.findMany({
      where: { paymentId },
      select: {
        status: true,
        amountMinor: true,
        idempotencyKey: true,
        reason: true,
      },
    });
    const processed = refunds
      .filter((r) => r.status === 'PROCESSED')
      .reduce((n, r) => n + r.amountMinor, 0);
    const open = refunds
      .filter((r) => OPEN.includes(r.status))
      .reduce((n, r) => n + r.amountMinor, 0);

    let paymentStatus: PaymentStatus;
    if (processed >= payment.capturedMinor && payment.capturedMinor > 0)
      paymentStatus = 'REFUNDED';
    else if (open > 0) paymentStatus = 'REFUND_PENDING';
    else if (processed > 0) paymentStatus = 'PARTIALLY_REFUNDED';
    else paymentStatus = 'CAPTURED';
    if (payment.status !== paymentStatus) {
      assertPaymentTransition(payment.status, paymentStatus);
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: paymentStatus },
      });
    }

    if (order.status === 'CANCELLED') return; // late-capture refunds do not reopen a cancelled order
    const actor = { type: 'SYSTEM' as const };

    // A STAFF cancel only requested the cancellation (OrderService.cancel). Once its refund has been PROCESSED, the
    // order is cancelled for real: stock back on the shelf, cancelledAt, the order.cancelled event.
    const cancelRefund = refunds.find(
      (r) =>
        r.status === 'PROCESSED' &&
        (r.idempotencyKey === `cancel:${orderId}` ||
          r.idempotencyKey.startsWith(`cancel:${orderId}:`)), // a later attempt after a rejected/failed one
    );
    let cancelledAt = order.cancelledAt;
    // Only an order that was still unshipped when its cancel refund was requested is cancelled (and restocked) here.
    const wasCancellable =
      order.status === 'REFUND_PENDING' &&
      order.statusBeforeRefund !== null &&
      PAID_CANCELLABLE.includes(order.statusBeforeRefund);
    if (cancelRefund && !cancelledAt && !wasCancellable)
      this.logger.error(
        { orderId },
        'A cancel refund was processed for an order that had shipped: not cancelled or restocked; check it by hand',
      );
    if (cancelRefund && !cancelledAt && wasCancellable) {
      const done = await this.lifecycle.markPaidOrderCancelledInTx(
        tx,
        orderId,
        cancelRefund.reason.replace(/^Order cancelled: /, ''),
        this.inventory,
      );
      cancelledAt = done.cancelledAt;
    }

    if (open > 0) {
      if (order.status !== 'REFUND_PENDING') {
        await this.lifecycle.transition(tx, orderId, 'REFUND_PENDING', actor, {
          reason: 'refund requested',
          extras: { statusBeforeRefund: order.status },
        });
      }
    } else if (
      order.status === 'REFUND_PENDING' ||
      order.status === 'PARTIALLY_REFUNDED'
    ) {
      // FIRST: a cancelled order (its goods already back on the shelf) never returns to a shippable state, even when an
      // earlier partial refund makes the payment PARTIALLY_REFUNDED. It waits in REFUND_PENDING until it is refunded.
      if (
        order.status === 'REFUND_PENDING' &&
        cancelledAt &&
        paymentStatus !== 'REFUNDED'
      ) {
        this.logger.warn(
          { orderId },
          'Refund for a cancelled order did not complete; the order is waiting for a manual refund',
        );
        return;
      }
      if (paymentStatus === 'REFUNDED')
        await this.lifecycle.transition(tx, orderId, 'REFUNDED', actor, {
          reason: 'fully refunded',
          event: { type: 'order.refunded' },
        });
      else if (paymentStatus === 'PARTIALLY_REFUNDED')
        await this.lifecycle.transition(
          tx,
          orderId,
          await this.statusAfterPartialRefund(tx, order),
          actor,
          {
            reason: 'partially refunded',
            event: { type: 'order.partially_refunded' },
          },
        );
      else if (order.status === 'REFUND_PENDING')
        await this.lifecycle.transition(
          tx,
          orderId,
          order.statusBeforeRefund ?? 'PAID',
          actor,
          { reason: 'refund did not complete' },
        );
    }
  }

  // ------------------------------------------------------------------------ reconciliation

  /** Resolves refunds stuck in APPROVED/PROCESSING (crash, timeout, missed webhook). Returns how many it touched. */
  async reconcile(olderThanSeconds = 60): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
    let touched = 0;
    for (const r of await this.prisma.refund.findMany({
      where: { status: 'APPROVED', updatedAt: { lt: cutoff } },
      take: 50,
    })) {
      await this.execute(r.id);
      touched++;
    }
    for (const r of await this.prisma.refund.findMany({
      where: { status: 'PROCESSING', updatedAt: { lt: cutoff } },
      include: { payment: true },
      take: 50,
    })) {
      const providerPaymentId = r.payment.providerPaymentId;
      if (!providerPaymentId) continue;
      try {
        const found = (await this.provider.listRefunds(providerPaymentId)).find(
          (x) => x.id === r.providerRefundId || x.receipt === r.receipt,
        );
        if (found) await this.applyProviderRefund(found);
        else if (Date.now() - r.updatedAt.getTime() > 5 * 60_000) {
          // The provider has NO record of our receipt: the earlier call never landed, so re-sending cannot double-refund.
          await this.prisma.refund.updateMany({
            where: { id: r.id, status: 'PROCESSING', providerRefundId: null },
            data: { status: 'APPROVED' },
          });
        }
        touched++;
      } catch (err) {
        this.logger.warn(
          { refundId: r.id, err: (err as Error).message },
          'Refund reconciliation could not reach the provider',
        );
      }
    }
    return touched;
  }

  get(id: string) {
    return this.prisma.refund.findUnique({ where: { id } });
  }
}
