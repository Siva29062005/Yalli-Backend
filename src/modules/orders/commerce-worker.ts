import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { CartService } from '../cart/cart.service.js';
import { CouponService } from '../coupons/coupon.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { RefundService } from '../refunds/refund.service.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';
import { UNPAID_CANCELLABLE } from './order-state-machine.js';

/**
 * Periodic safety nets. Each pass is idempotent and safe on several instances.
 *  - Expire unpaid orders, but ONLY after asking the provider whether money arrived (fail-safe: if the provider cannot be
 *    reached the order is left alone; we never cancel an order that might have been paid).
 *  - Re-check open payments (missed / delayed webhooks) and detect payments made after an order was cancelled.
 *  - Finish refunds stuck in APPROVED/PROCESSING.
 */
@Injectable()
export class CommerceWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CommerceWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly payments: PaymentService,
    private readonly refunds: RefundService,
    private readonly inventory: InventoryService,
    private readonly coupons: CouponService,
    private readonly idempotency: IdempotencyService,
    private readonly carts: CartService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('BACKGROUND_JOBS_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.runOnce(), 30_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce() {
    if (this.running) return null;
    this.running = true;
    try {
      const reconciledPayments = await this.reconcilePayments();
      const expiredOrders = await this.expireUnpaidOrders();
      const refundsTouched = await this.refunds.reconcile();
      const [idem, carts] = await Promise.all([
        this.idempotency.purgeExpired(),
        this.carts.purgeExpired(),
      ]);
      return {
        reconciledPayments,
        expiredOrders,
        refundsTouched,
        purged: idem + carts,
      };
    } catch (err) {
      this.logger.error({ err }, 'Commerce worker pass failed');
      return null;
    } finally {
      this.running = false;
    }
  }

  async expireUnpaidOrders(): Promise<number> {
    let cancelled = 0;
    for (const { id } of await this.lifecycle.expiredUnpaid()) {
      try {
        const verdict = await this.payments.reconcileOrderPayment(id); // throws if the provider cannot be asked
        if (
          verdict === 'captured' ||
          verdict === 'authorized' ||
          verdict === 'refunded_late' ||
          verdict === 'refunded_out_of_stock'
        )
          continue;
        await this.prisma.$transaction(async (tx) => {
          const order = await this.lifecycle.lock(tx, id);
          if (
            !UNPAID_CANCELLABLE.includes(order.status) ||
            order.paymentExpiresAt > new Date()
          )
            return; // changed meanwhile
          await this.lifecycle.cancelUnpaid(
            tx,
            id,
            { type: 'SYSTEM' },
            'payment window expired',
            this.inventory,
            this.coupons,
          );
          cancelled++;
        });
      } catch (err) {
        this.logger.warn(
          { orderId: id, err: (err as Error).message },
          'Could not expire order this pass; will retry',
        );
      }
    }
    return cancelled;
  }

  async reconcilePayments(limit = 25): Promise<number> {
    const since = new Date(Date.now() - 48 * 3_600_000);
    const stale = new Date(Date.now() - 2 * 60_000);
    const rows = await this.prisma.payment.findMany({
      where: {
        providerOrderId: { not: null },
        status: { in: ['PENDING', 'AUTHORIZED', 'FAILED', 'CANCELLED'] },
        createdAt: { gt: since },
        updatedAt: { lt: stale },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { orderId: true },
    });
    let n = 0;
    for (const r of rows) {
      try {
        await this.payments.reconcileOrderPayment(r.orderId);
        n++;
      } catch (err) {
        this.logger.warn(
          { orderId: r.orderId, err: (err as Error).message },
          'Payment reconciliation skipped (provider unreachable)',
        );
      }
    }
    return n;
  }
}
