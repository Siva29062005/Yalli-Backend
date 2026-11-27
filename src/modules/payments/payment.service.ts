import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Order, Payment, Prisma } from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { CouponService } from '../coupons/coupon.service.js';
import {
  InsufficientStockException,
  ReservationExpiredException,
  ReservationNotFoundException,
} from '../inventory/inventory.errors.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrderLifecycleService } from '../orders/order-lifecycle.service.js';
import { OrderViewService } from '../orders/order-view.service.js';
import { takeSerial } from '../orders/document-counter.js';
import { financialYear, invoiceNumber } from '../orders/tax-documents.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RefundService } from '../refunds/refund.service.js';
import {
  PaymentProvider,
  PaymentProviderError,
  type ProviderPayment,
} from './payment-provider.js';
import {
  assertPaymentTransition,
  MONEY_HELD_STATUSES,
} from './payment-state-machine.js';

type Tx = Prisma.TransactionClient;
export type PaymentSource =
  'WEBHOOK' | 'CONFIRM_CALLBACK' | 'RECONCILIATION' | 'SYSTEM';
export type ApplyOutcome =
  | 'captured'
  | 'authorized'
  | 'failed'
  | 'duplicate'
  | 'mismatch'
  | 'refunded_late'
  | 'refunded_out_of_stock'
  | 'ignored'
  | 'noop';

const PAYABLE = [
  'INVENTORY_RESERVED',
  'PAYMENT_PENDING',
  'PAYMENT_FAILED',
] as const;
const STALE_WEBHOOK_SECONDS = 7 * 24 * 3600;

/**
 * Money handling rules enforced here:
 *  - An order becomes PAID only inside `applyProviderPayment`, from facts fetched from the provider's API (never from what a
 *    browser or a request body claims), and only if amount, currency and provider order all match.
 *  - Webhooks, the browser callback and reconciliation all funnel through that ONE function, under row locks, so the same
 *    payment is processed once no matter how many times or in what order the signals arrive.
 *  - Money that arrives for an order we can no longer fulfil (cancelled, expired, out of stock) is refunded automatically.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly lifecycle: OrderLifecycleService,
    private readonly inventory: InventoryService,
    private readonly coupons: CouponService,
    private readonly refunds: RefundService,
    private readonly outbox: OutboxService,
    private readonly views: OrderViewService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------------------- initiate

  /** Opens (or re-opens) the provider order the browser pays against. Reusing it keeps one payable provider order per order. */
  async initiate(
    principal: AuthPrincipal,
    orderId: string,
    ctx: RequestContext,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId: principal.userId },
    }); // ownership in the query
    if (!order) throw new NotFoundException('Order not found');
    if (
      !(PAYABLE as readonly string[]).includes(order.status) ||
      order.paymentExpiresAt <= new Date()
    ) {
      throw new ConflictException({
        message: 'This order can no longer be paid',
        code: 'ORDER_NOT_PAYABLE',
      });
    }

    let payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        status: { in: ['CREATED', 'PENDING', 'AUTHORIZED', 'FAILED'] },
      },
      orderBy: { attempt: 'desc' },
    });
    if (payment?.providerOrderId) {
      if (payment.status === 'FAILED') {
        await this.prisma.$transaction(async (tx) => {
          await this.lifecycle.lock(tx, orderId);
          await tx.payment.update({
            where: { id: payment!.id },
            data: { status: 'PENDING', failureCode: null, failureReason: null },
          });
          await this.lifecycle.transition(
            tx,
            orderId,
            'PAYMENT_PENDING',
            { type: 'USER', id: principal.userId },
            { reason: 'payment retry' },
          );
        });
      }
      return this.checkoutPayload(
        order,
        payment.id,
        payment.providerOrderId,
        payment.amountMinor,
        principal.userId,
      );
    }

    if (!payment) {
      const attempt =
        ((
          await this.prisma.payment.aggregate({
            where: { orderId },
            _max: { attempt: true },
          })
        )._max.attempt ?? 0) + 1;
      try {
        payment = await this.prisma.payment.create({
          data: {
            orderId,
            provider: this.provider.name,
            amountMinor: order.totalMinor,
            currency: order.currency,
            attempt,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002')
          throw new ConflictException({
            message: 'A payment is already being set up for this order',
            code: 'PAYMENT_IN_PROGRESS',
          });
        throw err;
      }
    }

    // Only ONE request may create the provider order for this payment: an extra provider order that we do not record
    // could still be paid by the customer, and we could not match that money to an order. A claim older than 30 s is
    // treated as abandoned (the claiming process crashed), so a retry can proceed.
    const claim = await this.prisma.$executeRaw`
      UPDATE payments SET initiating_at = now(), updated_at = now()
      WHERE id = ${payment.id}::uuid AND provider_order_id IS NULL
        AND (initiating_at IS NULL OR initiating_at < now() - interval '30 seconds')`;
    if (claim !== 1) {
      throw new ConflictException({
        message:
          'A payment is already being set up for this order. Please retry in a moment.',
        code: 'PAYMENT_IN_PROGRESS',
      });
    }

    let providerOrderId: string;
    try {
      const po = await this.provider.createOrder({
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        receipt:
          payment.attempt > 1
            ? `${order.orderNumber}-${payment.attempt}`
            : order.orderNumber,
        notes: { orderId, orderNumber: order.orderNumber },
      });
      if (
        po.amountMinor !== payment.amountMinor ||
        po.currency !== payment.currency
      )
        throw new PaymentProviderError(
          'Provider order does not match the requested amount',
          true,
          'MISMATCH',
        );
      providerOrderId = po.providerOrderId;
    } catch (err) {
      // Release the claim so a retry can proceed. Any provider order that may have been created is harmless: its id was
      // never given to anyone, so nobody can pay it.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, providerOrderId: null },
        data: { initiatingAt: null },
      });
      const definitive = err instanceof PaymentProviderError && err.definitive;
      if (definitive)
        await this.prisma.payment.updateMany({
          where: { id: payment.id, providerOrderId: null },
          data: {
            status: 'FAILED',
            failureCode: 'PROVIDER_REJECTED',
            failureReason: 'The payment provider rejected the order',
          },
        });
      this.logger.error(
        { orderId, err: (err as Error).message },
        'Could not create provider order',
      );
      throw new ServiceUnavailableException({
        message:
          'Payments are temporarily unavailable. Please try again shortly.',
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lifecycle.lock(tx, orderId);
      await tx.payment.update({
        where: { id: payment!.id },
        data: { providerOrderId, status: 'PENDING' },
      });
      await this.lifecycle.transition(
        tx,
        orderId,
        'PAYMENT_PENDING',
        { type: 'USER', id: principal.userId },
        { reason: 'payment initiated' },
      );
      await tx.paymentEvent.create({
        data: {
          paymentId: payment!.id,
          provider: this.provider.name,
          type: 'payment.initiated',
          toStatus: 'PENDING',
          source: 'SYSTEM',
          data: { providerOrderId, amountMinor: payment!.amountMinor },
        },
      });
    });
    await this.audit.record({
      action: AuditAction.PaymentInitiated,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'order',
      resourceId: orderId,
      metadata: { paymentId: payment.id, amountMinor: payment.amountMinor },
    });
    return this.checkoutPayload(
      order,
      payment.id,
      providerOrderId,
      payment.amountMinor,
      principal.userId,
    );
  }

  private async checkoutPayload(
    order: Order,
    paymentId: string,
    providerOrderId: string,
    amountMinor: number,
    userId: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        phoneE164: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    });
    return {
      paymentId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      provider: this.provider.name,
      keyId: this.provider.publicConfig().keyId, // public identifier only, never the secret
      providerOrderId,
      amountMinor,
      currency: order.currency,
      prefill: {
        name: user.customer
          ? `${user.customer.firstName} ${user.customer.lastName}`
          : undefined,
        email: user.email,
        contact: user.phoneE164 ?? undefined,
      },
    };
  }

  // -------------------------------------------------------------------- browser callback

  /**
   * The browser says "I paid". That claim is NOT believed: we check the signature (proves the callback came from the
   * checkout for THIS provider order), then ask the provider directly what happened, and apply that.
   */
  async confirmCheckout(
    principal: AuthPrincipal,
    orderId: string,
    input: {
      providerOrderId: string;
      providerPaymentId: string;
      signature: string;
    },
    ctx: RequestContext,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId: principal.userId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const payment = order.payments.find(
      (p) => p.providerOrderId === input.providerOrderId,
    );
    if (!payment || !this.provider.verifyCheckoutSignature(input)) {
      await this.audit.record({
        action: AuditAction.PaymentCallbackRejected,
        outcome: 'DENIED',
        actorId: principal.userId,
        ...ctx,
        resourceType: 'order',
        resourceId: orderId,
        metadata: {
          reason: payment ? 'bad_signature' : 'unknown_provider_order',
        },
      });
      throw new BadRequestException({
        message: 'Payment verification failed',
        code: 'PAYMENT_VERIFICATION_FAILED',
      });
    }
    const facts = await this.fetchFacts(input.providerPaymentId);
    if (facts.orderId !== payment.providerOrderId) {
      await this.audit.record({
        action: AuditAction.PaymentCallbackRejected,
        outcome: 'DENIED',
        actorId: principal.userId,
        ...ctx,
        resourceType: 'order',
        resourceId: orderId,
        metadata: { reason: 'payment_belongs_to_other_order' },
      });
      throw new BadRequestException({
        message: 'Payment verification failed',
        code: 'PAYMENT_VERIFICATION_FAILED',
      });
    }
    await this.applyAndFinish(payment.id, facts, 'CONFIRM_CALLBACK', undefined);
    const fresh = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    return {
      status: fresh.status,
      paid: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(
        fresh.status,
      ),
      order: this.views.customer(fresh),
    };
  }

  // ---------------------------------------------------------------------------- webhooks

  /**
   * Webhook entry point. Order of operations matters:
   *  1. signature over the RAW bytes (before anything is parsed or trusted) -> 401
   *  2. parse -> 400; ancient events are acknowledged and ignored (replay window)
   *  3. ask the provider for the CURRENT truth of the payment (events may arrive late or out of order)
   *  4. one transaction: record the event id (unique => duplicates are no-ops) + apply the change. A failure rolls the
   *     event id back too, so the provider's retry is processed for real.
   */
  async processWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    ctx: RequestContext,
  ): Promise<{ outcome: string }> {
    const sig = headers['x-razorpay-signature'];
    if (
      !this.provider.verifyWebhook(rawBody, Array.isArray(sig) ? sig[0] : sig)
    ) {
      await this.audit.record({
        action: AuditAction.WebhookRejected,
        outcome: 'DENIED',
        ...ctx,
        metadata: { reason: 'bad_signature' },
      });
      throw new UnauthorizedException('Invalid signature');
    }
    const event = this.provider.parseWebhook(rawBody, headers);
    if (!event) throw new BadRequestException('Unreadable webhook');
    // The event-id header is NOT covered by the signature, so it cannot be trusted as the only replay guard. The signed
    // BODY can: an exact replay is recognised here, before any outbound provider request is made. It is recorded only after
    // the event was handled, so a delivery that failed halfway is still retried by the provider.
    const bodyKey = `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
    const seen = await this.prisma.webhookInbox.findUnique({
      where: {
        provider_providerEventId: {
          provider: this.provider.name,
          providerEventId: bodyKey,
        },
      },
      select: { id: true },
    });
    if (seen) return { outcome: 'duplicate' };
    const result = await this.applyWebhookEvent(event);
    await this.recordInbox(this.prisma, bodyKey, event.type, result.outcome);
    return result;
  }

  private async applyWebhookEvent(
    event: NonNullable<ReturnType<PaymentProvider['parseWebhook']>>,
  ): Promise<{ outcome: string }> {
    if (Date.now() / 1000 - event.createdAt > STALE_WEBHOOK_SECONDS) {
      await this.recordInbox(this.prisma, event.id, event.type, 'stale');
      return { outcome: 'stale' };
    }

    // Refund events carry the payment AND the refund entity; they must be handled as refunds, never as payment updates.
    if (event.refund && event.type.startsWith('refund.')) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        if (!(await this.recordInbox(tx, event.id, event.type, 'processing')))
          return 'duplicate';
        return 'recorded';
      });
      if (outcome === 'duplicate') return { outcome };
      const result = await this.refunds.applyProviderRefund(event.refund);
      await this.prisma.webhookInbox.updateMany({
        where: { provider: this.provider.name, providerEventId: event.id },
        data: { outcome: result },
      });
      return { outcome: result };
    }

    if (event.payment) {
      const ours = event.payment.orderId
        ? await this.prisma.payment.findUnique({
            where: { providerOrderId: event.payment.orderId },
          })
        : null;
      if (!ours) {
        await this.recordInbox(
          this.prisma,
          event.id,
          event.type,
          'unknown_order',
        );
        return { outcome: 'unknown_order' };
      }
      const facts = await this.fetchFacts(event.payment.id); // network call BEFORE the transaction
      const outcome = await this.prisma.$transaction(async (tx) => {
        if (!(await this.recordInbox(tx, event.id, event.type, 'processing')))
          return 'duplicate' as const;
        const result = await this.applyProviderPayment(
          tx,
          ours.id,
          facts,
          'WEBHOOK',
          event.id,
        );
        await tx.webhookInbox.updateMany({
          where: { provider: this.provider.name, providerEventId: event.id },
          data: { outcome: result },
        });
        return result;
      });
      await this.afterApply(ours.id, outcome);
      return { outcome };
    }

    await this.recordInbox(this.prisma, event.id, event.type, 'ignored');
    return { outcome: 'ignored' };
  }

  /** false => this event id was already recorded (a redelivery). */
  private async recordInbox(
    db: Tx | PrismaService,
    eventId: string,
    type: string,
    outcome: string,
  ): Promise<boolean> {
    try {
      await db.webhookInbox.create({
        data: {
          provider: this.provider.name,
          providerEventId: eventId,
          eventType: type.slice(0, 60),
          outcome,
        },
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false;
      throw err;
    }
  }

  // ------------------------------------------------------------------------ core transition

  private async fetchFacts(
    providerPaymentId: string,
  ): Promise<ProviderPayment> {
    try {
      return await this.provider.fetchPayment(providerPaymentId);
    } catch (err) {
      // Cannot verify with the provider: fail (5xx) so the webhook is retried / the customer retries; never guess.
      this.logger.warn(
        { err: (err as Error).message },
        'Could not fetch payment from the provider',
      );
      throw new HttpException(
        {
          message: 'Could not verify the payment with the provider yet',
          code: 'PAYMENT_VERIFICATION_UNAVAILABLE',
        },
        503,
      );
    }
  }

  private async applyAndFinish(
    paymentId: string,
    facts: ProviderPayment,
    source: PaymentSource,
    eventId: string | undefined,
  ): Promise<ApplyOutcome> {
    const outcome = await this.prisma.$transaction((tx) =>
      this.applyProviderPayment(tx, paymentId, facts, source, eventId),
    );
    await this.afterApply(paymentId, outcome);
    return outcome;
  }

  /** Post-commit follow-ups: capture an authorized payment, and push any auto-refund to the provider. */
  private async afterApply(
    paymentId: string,
    outcome: ApplyOutcome | 'duplicate',
  ): Promise<void> {
    if (outcome === 'authorized')
      await this.captureIfAuthorized(paymentId).catch((e) =>
        this.logger.warn(
          { err: (e as Error).message },
          'Capture of authorized payment failed; reconciliation will retry',
        ),
      );
    if (outcome === 'refunded_late' || outcome === 'refunded_out_of_stock') {
      for (const r of await this.prisma.refund.findMany({
        where: { paymentId, status: 'APPROVED' },
      }))
        await this.refunds.execute(r.id).catch(() => undefined);
    }
  }

  /**
   * Captures the authorized payment of an order, at most ONCE:
   * - one attempt at a time per payment (a claim in the database, stale after 2 minutes, so a crashed attempt is retried
   *   by reconciliation), which also ends any capture -> "authorized" -> capture loop;
   * - if the provider already shows a CAPTURED payment for this provider order (an earlier capture call timed out but
   *   worked), that one is applied and nothing else is captured: a second authorization (another tab, a UPI retry) is
   *   left to lapse and the provider voids it. Capturing it would charge the customer twice.
   */
  async captureIfAuthorized(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment?.providerOrderId) return;
    const claimed = await this.prisma.$executeRaw`
      UPDATE payments SET capture_started_at = now()
      WHERE id = ${paymentId}::uuid AND status = 'AUTHORIZED'
        AND (capture_started_at IS NULL OR capture_started_at < now() - interval '2 minutes')`;
    if (claimed !== 1) return;
    const found = await this.provider.fetchOrderPayments(
      payment.providerOrderId,
    );
    const alreadyCaptured = found.find((p) => p.status === 'captured');
    if (alreadyCaptured) {
      await this.applyAndFinish(
        paymentId,
        alreadyCaptured,
        'RECONCILIATION',
        undefined,
      );
      return;
    }
    const candidate = found.find(
      (p) =>
        p.status === 'authorized' &&
        p.amountMinor === payment.amountMinor &&
        p.currency === payment.currency, // never capture an unexpected amount
    );
    if (!candidate) return;
    const captured = await this.provider.capturePayment(
      candidate.id,
      payment.amountMinor,
      payment.currency,
    );
    await this.applyAndFinish(paymentId, captured, 'SYSTEM', undefined);
  }

  /**
   * THE state transition for payments. Runs inside a transaction, ORDER row then PAYMENT row locked (same order as every
   * other path), and is idempotent: replays, duplicates and out-of-order signals converge on the same final state.
   */
  async applyProviderPayment(
    tx: Tx,
    paymentId: string,
    facts: ProviderPayment,
    source: PaymentSource,
    eventId: string | undefined,
  ): Promise<ApplyOutcome> {
    const pre = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { orderId: true },
    });
    const order = await this.lifecycle.lock(tx, pre.orderId);
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    const record = (
      type: string,
      from: string | null,
      to: string | null,
      data: Record<string, unknown>,
    ) =>
      tx.paymentEvent.create({
        data: {
          paymentId,
          provider: this.provider.name,
          providerEventId: eventId ?? null,
          type,
          fromStatus: from,
          toStatus: to,
          source,
          data: {
            providerPaymentId: facts.id,
            providerStatus: facts.status,
            amountMinor: facts.amountMinor,
            ...data,
          } as Prisma.InputJsonValue,
        },
      });

    if (facts.orderId !== payment.providerOrderId) {
      await record('payment.wrong_order', payment.status, null, {});
      return 'ignored';
    }

    switch (facts.status) {
      case 'captured':
        return this.onCaptured(tx, order, payment, facts, source, record);
      case 'authorized':
        if (MONEY_HELD_STATUSES.includes(payment.status)) return 'duplicate';
        // An authorization for a different amount is never captured; report it as a mismatch so it neither blocks the
        // expiry of the order nor triggers capture attempts.
        if (
          facts.amountMinor !== payment.amountMinor ||
          facts.currency !== payment.currency
        ) {
          await record('payment.amount_mismatch', payment.status, null, {
            expectedMinor: payment.amountMinor,
            currency: facts.currency,
            stage: 'authorized',
          });
          return 'mismatch';
        }
        // Still authorized but not captured (an earlier capture call failed): report it again so the caller retries
        // the capture. Treating it as a duplicate left the money uncaptured until the expiry job cancelled the order.
        if (payment.status === 'AUTHORIZED') return 'authorized';
        // PENDING/CREATED: first authorization. FAILED: the customer retried inside the provider's checkout on the same
        // provider order after a failed attempt, and the order is still payable (PAYMENT_FAILED); accept it.
        if (
          payment.status === 'PENDING' ||
          payment.status === 'CREATED' ||
          (payment.status === 'FAILED' &&
            (PAYABLE as readonly string[]).includes(order.status))
        ) {
          await tx.payment.update({
            where: { id: paymentId },
            data: {
              status: 'AUTHORIZED',
              failureCode: null,
              failureReason: null,
            },
          });
          await record('payment.authorized', payment.status, 'AUTHORIZED', {});
          return 'authorized';
        }
        return 'ignored';
      case 'failed':
        return this.onFailed(tx, order, payment, facts, record);
      default:
        return 'noop'; // `created` / `refunded`: refunds are tracked through the refund flow, not inferred here
    }
  }

  private async onFailed(
    tx: Tx,
    order: Order,
    payment: Payment,
    facts: ProviderPayment,
    record: (
      t: string,
      f: string | null,
      to: string | null,
      d: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<ApplyOutcome> {
    // A failed attempt arriving AFTER a successful capture (out-of-order delivery, or an earlier attempt in the same provider
    // order) must never undo a captured payment.
    if (
      MONEY_HELD_STATUSES.includes(payment.status) ||
      payment.status === 'FAILED' ||
      payment.status === 'CANCELLED'
    ) {
      await record('payment.failed_ignored', payment.status, null, {
        errorCode: facts.errorCode,
      });
      return 'ignored';
    }
    assertPaymentTransition(payment.status, 'FAILED');
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        failureCode: facts.errorCode,
        failureReason: facts.errorDescription,
      },
    });
    await record('payment.failed', payment.status, 'FAILED', {
      errorCode: facts.errorCode,
    });
    if (order.status === 'PAYMENT_PENDING') {
      await this.lifecycle.transition(
        tx,
        order.id,
        'PAYMENT_FAILED',
        { type: 'PROVIDER' },
        {
          reason: facts.errorCode ?? 'payment failed',
          event: { type: 'order.payment_failed' },
        },
      );
    }
    return 'failed';
  }

  private async onCaptured(
    tx: Tx,
    order: Order,
    payment: Payment,
    facts: ProviderPayment,
    source: PaymentSource,
    record: (
      t: string,
      f: string | null,
      to: string | null,
      d: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<ApplyOutcome> {
    if (MONEY_HELD_STATUSES.includes(payment.status)) {
      if (payment.providerPaymentId !== facts.id) {
        // A SECOND capture on one provider order should be impossible; if it ever happens a human must look at it.
        await record('payment.duplicate_capture', payment.status, null, {
          otherPaymentId: payment.providerPaymentId,
        });
        await this.audit.recordInTx(tx, {
          action: AuditAction.PaymentAmountMismatch,
          outcome: 'FAILURE',
          resourceType: 'payment',
          resourceId: payment.id,
          metadata: {
            reason: 'second_capture_on_one_provider_order',
            providerPaymentId: facts.id,
          },
        });
      }
      return 'duplicate';
    }

    // The paid amount must be EXACTLY what we asked for. Anything else is never accepted as "paid".
    if (
      facts.amountMinor !== payment.amountMinor ||
      facts.currency !== payment.currency
    ) {
      await record('payment.amount_mismatch', payment.status, null, {
        expectedMinor: payment.amountMinor,
        currency: facts.currency,
      });
      await this.audit.recordInTx(tx, {
        action: AuditAction.PaymentAmountMismatch,
        outcome: 'FAILURE',
        resourceType: 'payment',
        resourceId: payment.id,
        metadata: {
          expectedMinor: payment.amountMinor,
          receivedMinor: facts.amountMinor,
          orderId: order.id,
        },
      });
      this.logger.error(
        {
          paymentId: payment.id,
          expected: payment.amountMinor,
          got: facts.amountMinor,
        },
        'PAYMENT AMOUNT MISMATCH: order NOT marked paid',
      );
      return 'mismatch';
    }

    assertPaymentTransition(payment.status, 'CAPTURED');
    const now = new Date();
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'CAPTURED',
        providerPaymentId: facts.id,
        capturedMinor: facts.amountMinor,
        capturedAt: now,
        method: facts.method,
        failureCode: null,
        failureReason: null,
      },
    });
    await record('payment.captured', payment.status, 'CAPTURED', {
      method: facts.method,
    });
    await this.outbox.add(tx, {
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType: 'payment.captured',
      payload: {
        paymentId: payment.id,
        orderId: order.id,
        amountMinor: facts.amountMinor,
      },
    });

    // ---- what to do with the ORDER ----
    if (
      order.status === 'PAYMENT_PENDING' ||
      order.status === 'PAYMENT_FAILED'
    ) {
      const stock = await this.commitStockForPaidOrder(tx, order);
      if (stock === 'ok') {
        // The GST invoice number is taken in the SAME transaction as PAID: gapless per financial year (India time).
        const fy = financialYear(now);
        const invoice = invoiceNumber(
          fy.short,
          await takeSerial(tx, `invoice:${fy.label}`),
        );
        await this.lifecycle.transition(
          tx,
          order.id,
          'PAID',
          { type: source === 'WEBHOOK' ? 'PROVIDER' : 'SYSTEM' },
          {
            reason: `payment captured (${source.toLowerCase()})`,
            extras: { paidAt: now, invoiceNumber: invoice },
            event: {
              type: 'order.paid',
              payload: { totalMinor: order.totalMinor },
            },
          },
        );
        return 'captured';
      }
      // Paid, but the goods are gone: cancel and give the money back automatically.
      await this.cancelAfterCapture(
        tx,
        order,
        payment,
        'Item(s) sold out before payment completed',
      );
      return 'refunded_out_of_stock';
    }
    if (order.status === 'CANCELLED') {
      // The customer paid after we released the order (expired / abandoned). Refund in full, automatically.
      await this.refunds.requestInTx(tx, {
        paymentId: payment.id,
        kind: 'LATE_CAPTURE',
        amountMinor: payment.amountMinor,
        reason: 'Payment received after the order was cancelled',
        requestedById: null,
        autoApprove: true,
        idempotencyKey: `late-capture:${payment.id}`,
      });
      await this.audit.recordInTx(tx, {
        action: AuditAction.PaymentCaptured,
        outcome: 'SUCCESS',
        resourceType: 'payment',
        resourceId: payment.id,
        metadata: {
          note: 'late capture on cancelled order: auto-refund raised',
          orderId: order.id,
        },
      });
      return 'refunded_late';
    }
    return 'duplicate'; // order already PAID/PROCESSING/...: nothing more to do
  }

  /** Converts the held reservation into a sale. If the hold lapsed, tries to take stock again before giving up. */
  private async commitStockForPaidOrder(
    tx: Tx,
    order: Order,
  ): Promise<'ok' | 'out_of_stock'> {
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { variantId: true, quantity: true },
    });
    const ref = { referenceType: 'ORDER', referenceId: order.id };
    try {
      await this.inventory.commitInTx(tx, ref, items);
      return 'ok';
    } catch (err) {
      if (
        !(err instanceof ReservationExpiredException) &&
        !(err instanceof ReservationNotFoundException)
      )
        throw err;
    }
    // The hold lapsed (webhook arrived after the window). Release any remnants, then try a fresh reservation.
    await this.inventory.releaseInTx(tx, ref, 'late payment: re-reserving');
    const lateRef = { referenceType: 'ORDER_LATE', referenceId: order.id };
    try {
      await this.inventory.reserveInTx(tx, lateRef, items, 300);
      await this.inventory.commitInTx(tx, lateRef, items);
      return 'ok';
    } catch (err) {
      if (err instanceof InsufficientStockException) {
        await this.inventory.releaseInTx(
          tx,
          lateRef,
          'late payment: out of stock',
        );
        return 'out_of_stock';
      }
      throw err;
    }
  }

  private async cancelAfterCapture(
    tx: Tx,
    order: Order,
    payment: Payment,
    reason: string,
  ): Promise<void> {
    const now = new Date();
    await this.lifecycle.transition(
      tx,
      order.id,
      'CANCELLED',
      { type: 'SYSTEM' },
      {
        reason,
        extras: {
          cancelledAt: now,
          cancelReason: reason,
          inventoryReleasedAt: now,
        },
        event: { type: 'order.cancelled', payload: { reason, paid: true } },
      },
    );
    await this.coupons.releaseInTx(tx, 'ORDER', order.id);
    await this.refunds.requestInTx(tx, {
      paymentId: payment.id,
      kind: 'LATE_CAPTURE',
      amountMinor: payment.amountMinor,
      reason,
      requestedById: null,
      autoApprove: true,
      idempotencyKey: `late-capture:${payment.id}`,
    });
  }

  // --------------------------------------------------------------------------- reconcile

  /** Asks the provider what really happened to an order's payment(s) and applies it. Used by the expiry and reconcile jobs. */
  async reconcileOrderPayment(orderId: string): Promise<ApplyOutcome | 'none'> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, providerOrderId: { not: null } },
      orderBy: { attempt: 'desc' },
    });
    if (!payment?.providerOrderId) return 'none';
    const found = await this.provider.fetchOrderPayments(
      payment.providerOrderId,
    );
    let result: ApplyOutcome | 'none' = 'none';
    for (const status of ['captured', 'authorized'] as const) {
      const p = found.find((x) => x.status === status);
      if (p) {
        result = await this.applyAndFinish(
          payment.id,
          p,
          'RECONCILIATION',
          undefined,
        );
        break;
      }
    }
    await this.prisma.payment.updateMany({
      where: { id: payment.id },
      data: { updatedAt: new Date() },
    }); // rotate the oldest-first queue
    return result;
  }

  /** Status for the browser to poll after paying (it never decides anything itself). */
  async orderPaymentStatus(principal: AuthPrincipal, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId: principal.userId },
      select: { id: true, status: true, paidAt: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return {
      orderId: order.id,
      status: order.status,
      paid: order.paidAt !== null,
    };
  }
}
