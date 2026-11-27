import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import { CouponService } from '../coupons/coupon.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { sameStateSupply, splitGst } from '../orders/gst.js';
import { OrderLifecycleService } from '../orders/order-lifecycle.service.js';
import { OrderViewService } from '../orders/order-view.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  priceCart,
  type CouponRule,
  type PricingLine,
  type PricingResult,
} from '../pricing/cart-pricing.js';
import { effectivePrice } from '../pricing/price.js';
import { ShippingService } from '../shipping/shipping.service.js';
import type { ShippingChoice } from '../shipping/shipping-rules.js';

type Db = Prisma.TransactionClient | PrismaService;

interface BasketLine {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  imageKey: string | null;
  hsnCode: string | null;
  quantity: number;
  unitPriceMinor: number;
  compareAtMinor: number | null;
  gstRateBps: number;
  categoryIds: string[];
}

/** Order-line columns for the line's share of the delivery fee and the CGST/SGST or IGST inside it. */
function shippingTax(shareMinor: number, gstMinor: number, sameState: boolean) {
  const split = splitGst(gstMinor, sameState);
  return {
    shippingShareMinor: shareMinor,
    shippingGstMinor: gstMinor,
    shippingCgstMinor: split.cgstMinor,
    shippingSgstMinor: split.sgstMinor,
    shippingIgstMinor: split.igstMinor,
  };
}

@Injectable()
export class CheckoutService {
  private readonly sellerState: string;
  private readonly paymentWindowSeconds: number;
  private readonly maxOpenOrders: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly coupons: CouponService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly outbox: OutboxService,
    private readonly views: OrderViewService,
    private readonly audit: AuditService,
    private readonly shipping: ShippingService,
  ) {
    this.sellerState = config.get('SELLER_STATE', { infer: true });
    this.maxOpenOrders = config.get('MAX_OPEN_UNPAID_ORDERS', { infer: true });
    this.paymentWindowSeconds =
      config.get('PAYMENT_WINDOW_MINUTES', { infer: true }) * 60;
  }

  // ------------------------------------------------------------------------------------ basket

  private async loadBasket(
    db: Db,
    userId: string,
  ): Promise<{
    lines: BasketLine[];
    couponCode: string | null;
    problems: { variantId: string; issue: string }[];
  }> {
    const cart = await db.cart.findUnique({
      where: { userId },
      include: {
        items: {
          orderBy: { addedAt: 'asc' },
          include: {
            variant: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    status: true,
                    deletedAt: true,
                    gstRateBps: true,
                    hsnCode: true,
                    categories: { select: { categoryId: true } },
                    images: {
                      orderBy: { position: 'asc' },
                      take: 1,
                      select: { storageKey: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!cart || cart.items.length === 0)
      throw new ConflictException({
        message: 'Your cart is empty',
        code: 'CART_EMPTY',
      });

    const stock = await this.inventory.availability(
      cart.items.map((i) => i.variantId),
      db,
    );
    const now = new Date();
    const lines: BasketLine[] = [];
    const problems: { variantId: string; issue: string }[] = [];
    for (const item of cart.items) {
      const v = item.variant;
      const live =
        v.isActive &&
        !v.deletedAt &&
        v.product.status === 'PUBLISHED' &&
        !v.product.deletedAt;
      if (!live) problems.push({ variantId: v.id, issue: 'UNAVAILABLE' });
      else if ((stock.get(v.id)?.available ?? 0) < item.quantity)
        problems.push({ variantId: v.id, issue: 'INSUFFICIENT_STOCK' });
      const price = effectivePrice(v, now);
      lines.push({
        variantId: v.id,
        productId: v.product.id,
        sku: v.sku,
        productName: v.product.name,
        variantName: v.name,
        imageKey: v.product.images[0]?.storageKey ?? null,
        hsnCode: v.product.hsnCode,
        quantity: item.quantity,
        unitPriceMinor: price.unitPriceMinor,
        compareAtMinor: price.compareAtMinor,
        gstRateBps: v.product.gstRateBps,
        categoryIds: v.product.categories.map((c) => c.categoryId),
      });
    }
    return { lines, couponCode: cart.couponCode, problems };
  }

  private async priceBasket(
    userId: string,
    lines: BasketLine[],
    couponCode: string | null,
    dest: {
      db: Db;
      state: string;
      shippingCode: string | undefined;
      mode: 'quote' | 'order';
    },
  ): Promise<{
    priced: PricingResult;
    rule: CouponRule | null;
    couponId: string | null;
    shipping: ShippingChoice;
  }> {
    let rule: CouponRule | null = null;
    let couponId: string | null = null;
    if (couponCode) {
      const coupon = await this.coupons.findByCode(couponCode, dest.db);
      const reason = coupon
        ? await this.coupons.unusableReason(coupon, userId, new Date(), dest.db)
        : 'INVALID';
      if (!coupon || reason)
        throw new ConflictException({
          message:
            'The coupon on your cart is no longer valid. Remove it to continue.',
          code: 'COUPON_INVALID',
        });
      rule = this.coupons.toRule(coupon);
      couponId = coupon.id;
    }
    const pricingLines: PricingLine[] = lines.map((l) => ({
      key: l.variantId,
      productId: l.productId,
      categoryIds: l.categoryIds,
      unitPriceMinor: l.unitPriceMinor,
      quantity: l.quantity,
      gstRateBps: l.gstRateBps,
    }));
    let priced = priceCart(pricingLines, rule, 0);
    if (rule && priced.couponRejection)
      throw new ConflictException({
        message:
          'The coupon on your cart does not apply any more. Remove it to continue.',
        code: 'COUPON_NOT_APPLICABLE',
      });
    // Delivery fee: decided server-side from the items total AFTER discount, then priced once more (pure, cheap).
    const shipping = await this.shipping.resolve(dest.db, {
      state: dest.state,
      payableMinor: priced.totalMinor,
      requestedCode: dest.shippingCode,
      mode: dest.mode,
    });
    if (shipping.kind === 'SELECTED' && shipping.option.feeMinor > 0)
      priced = priceCart(pricingLines, rule, shipping.option.feeMinor);
    return { priced, rule, couponId, shipping };
  }

  private async ownAddress(db: Db, userId: string, addressId: string) {
    const a = await db.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    });
    if (!a) throw new NotFoundException('Address not found');
    return a;
  }

  // -------------------------------------------------------------------------------------- quote

  /** Side-effect-free preview with the tax split for the chosen address. */
  async quote(
    principal: AuthPrincipal,
    addressId: string,
    shippingMethodCode?: string,
  ) {
    const address = await this.ownAddress(
      this.prisma,
      principal.userId,
      addressId,
    );
    const { lines, couponCode, problems } = await this.loadBasket(
      this.prisma,
      principal.userId,
    );
    const { priced, shipping } = await this.priceBasket(
      principal.userId,
      lines,
      couponCode,
      {
        db: this.prisma,
        state: address.state,
        shippingCode: shippingMethodCode,
        mode: 'quote',
      },
    );
    const same = sameStateSupply(address.state, this.sellerState);
    return {
      purchasable:
        problems.length === 0 &&
        shipping.kind !== 'UNAVAILABLE' &&
        shipping.kind !== 'INVALID_CODE',
      shipping: shippingView(shipping),
      problems,
      items: priced.lines.map((l) => ({
        variantId: l.key,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        lineTotalMinor: l.totalMinor,
        lineDiscountMinor: l.discountMinor,
      })),
      totals: {
        subtotalMinor: priced.subtotalMinor,
        discountMinor: priced.discountMinor,
        shippingMinor: priced.shippingMinor,
        gstIncludedMinor: priced.gstIncludedMinor,
        totalMinor: priced.totalMinor,
        currency: 'INR',
      },
      tax: {
        supply: same ? 'INTRA_STATE' : 'INTER_STATE',
        ...splitGst(priced.gstIncludedMinor, same),
      },
      coupon: priced.coupon,
    };
  }

  // ------------------------------------------------------------------------------- place order

  /**
   * One transaction: lock cart -> re-price -> create order + immutable snapshots -> reserve stock -> redeem coupon ->
   * empty the cart -> outbox event. If ANY step fails (stock, coupon limit, constraint) NOTHING is kept.
   * Payment is a separate step: an order is never marked paid here.
   */
  async placeOrder(
    principal: AuthPrincipal,
    input: {
      addressId: string;
      expectedTotalMinor?: number | undefined;
      shippingMethodCode?: string | undefined;
    },
    ctx: RequestContext,
  ) {
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM carts WHERE user_id = ${principal.userId}::uuid FOR UPDATE`;
      // Each unpaid order holds stock for the payment window. The cart lock above serialises this customer's checkouts, so
      // the count cannot be raced past the cap by parallel requests.
      const open = await tx.order.count({
        where: {
          userId: principal.userId,
          status: {
            in: [
              'CREATED',
              'INVENTORY_RESERVED',
              'PAYMENT_PENDING',
              'PAYMENT_FAILED',
            ],
          },
          paymentExpiresAt: { gt: new Date() },
        },
      });
      if (open >= this.maxOpenOrders)
        throw new ConflictException({
          message:
            'You have several orders waiting for payment. Please pay for or cancel one of them first.',
          code: 'TOO_MANY_OPEN_ORDERS',
        });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { email: true, phoneE164: true },
      });
      const address = await this.ownAddress(
        tx,
        principal.userId,
        input.addressId,
      );
      const { lines, couponCode, problems } = await this.loadBasket(
        tx,
        principal.userId,
      );
      if (problems.length > 0)
        throw new ConflictException({
          message: 'Some items in your cart are no longer available',
          code: 'CART_HAS_UNAVAILABLE_ITEMS',
          issues: problems.map((p) => ({
            path: [p.variantId],
            message: p.issue,
          })),
        });
      const { priced, couponId, shipping } = await this.priceBasket(
        principal.userId,
        lines,
        couponCode,
        {
          db: tx,
          state: address.state,
          shippingCode: input.shippingMethodCode,
          mode: 'order',
        },
      );
      if (
        shipping.kind === 'UNAVAILABLE' ||
        shipping.kind === 'CHOICE_REQUIRED' ||
        shipping.kind === 'INVALID_CODE'
      )
        throw new ConflictException({
          message:
            shipping.kind === 'UNAVAILABLE'
              ? 'We do not deliver to this address yet'
              : shipping.kind === 'CHOICE_REQUIRED'
                ? 'Choose a delivery method'
                : 'That delivery method is not available for this address',
          code:
            shipping.kind === 'UNAVAILABLE'
              ? 'SHIPPING_UNAVAILABLE'
              : shipping.kind === 'CHOICE_REQUIRED'
                ? 'SHIPPING_METHOD_REQUIRED'
                : 'SHIPPING_METHOD_INVALID',
        });
      if (
        input.expectedTotalMinor !== undefined &&
        input.expectedTotalMinor !== priced.totalMinor
      ) {
        throw new ConflictException({
          message:
            'The price changed since you last looked. Please review your cart.',
          code: 'PRICE_CHANGED',
          issues: [
            { path: ['totalMinor'], message: String(priced.totalMinor) },
          ],
        });
      }

      const same = sameStateSupply(address.state, this.sellerState);
      const seq = (
        await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT nextval('order_number_seq') AS n`
      )[0];
      if (!seq) throw new Error('order number sequence unavailable');
      const orderNumber = `YL${String(new Date().getFullYear()).slice(2)}-${seq.n}`;
      const byKey = new Map(priced.lines.map((l) => [l.key, l]));

      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: principal.userId,
          subtotalMinor: priced.subtotalMinor,
          discountMinor: priced.discountMinor,
          shippingMinor: priced.shippingMinor,
          shippingMethodCode:
            shipping.kind === 'SELECTED' ? shipping.option.code : null,
          shippingMethodName:
            shipping.kind === 'SELECTED' ? shipping.option.name : null,
          gstIncludedMinor: priced.gstIncludedMinor,
          totalMinor: priced.totalMinor,
          couponId: priced.coupon ? couponId : null,
          couponCode: priced.coupon?.code ?? null,
          contactEmail: user.email,
          contactPhone: user.phoneE164,
          shipName: address.fullName,
          shipPhone: address.phoneE164,
          shipLine1: address.line1,
          shipLine2: address.line2,
          shipLandmark: address.landmark,
          shipCity: address.city,
          shipState: address.state,
          shipPostalCode: address.postalCode,
          paymentExpiresAt: new Date(
            Date.now() + this.paymentWindowSeconds * 1000,
          ),
          items: {
            create: lines.map((l) => {
              const p = byKey.get(l.variantId)!;
              return {
                variantId: l.variantId,
                productId: l.productId,
                sku: l.sku,
                productName: l.productName,
                variantName: l.variantName,
                imageKey: l.imageKey,
                hsnCode: l.hsnCode,
                unitPriceMinor: l.unitPriceMinor,
                compareAtMinor: l.compareAtMinor,
                quantity: l.quantity,
                lineSubtotalMinor: p.subtotalMinor,
                lineDiscountMinor: p.discountMinor,
                lineTotalMinor: p.totalMinor,
                gstRateBps: l.gstRateBps,
                gstIncludedMinor: p.gstIncludedMinor,
                ...splitGst(p.gstIncludedMinor, same),
                // The delivery fee is taxed with the goods it carries (composite supply), at this line's rate.
                ...shippingTax(p.shippingShareMinor, p.shippingGstMinor, same),
              };
            }),
          },
        },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: created.id,
          toStatus: 'CREATED',
          actorType: 'USER',
          actorId: principal.userId,
          reason: 'checkout',
        },
      });

      // Stock first (the scarce resource). InsufficientStock aborts everything above.
      await this.inventory.reserveInTx(
        tx,
        { referenceType: 'ORDER', referenceId: created.id },
        lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        this.paymentWindowSeconds,
      );
      await this.lifecycle.transition(
        tx,
        created.id,
        'INVENTORY_RESERVED',
        { type: 'SYSTEM' },
        { reason: 'stock reserved' },
      );

      if (priced.coupon && couponId) {
        await this.coupons.redeemInTx(tx, {
          couponId,
          userId: principal.userId,
          referenceType: 'ORDER',
          referenceId: created.id,
          discountMinor: priced.discountMinor,
        });
      }
      await tx.cartItem.deleteMany({
        where: { cart: { userId: principal.userId } },
      });
      await tx.cart.updateMany({
        where: { userId: principal.userId },
        data: { couponCode: null },
      });
      await this.outbox.add(tx, {
        aggregateType: 'order',
        aggregateId: created.id,
        eventType: 'order.created',
        correlationId: ctx.correlationId,
        payload: {
          orderId: created.id,
          orderNumber,
          userId: principal.userId,
          totalMinor: priced.totalMinor,
        },
      });
      return tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { items: true, history: { orderBy: { createdAt: 'asc' } } },
      });
    });
    await this.audit.record({
      action: AuditAction.OrderCreated,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'order',
      resourceId: order.id,
      metadata: {
        orderNumber: order.orderNumber,
        totalMinor: order.totalMinor,
        items: order.items.length,
      },
    });
    return this.views.customer(order);
  }
}

function shippingView(s: ShippingChoice) {
  switch (s.kind) {
    case 'NOT_CONFIGURED':
      return { status: 'FREE' as const, selected: null, options: [] };
    case 'UNAVAILABLE':
      return { status: 'UNAVAILABLE' as const, selected: null, options: [] };
    case 'CHOICE_REQUIRED':
      return {
        status: 'CHOICE_REQUIRED' as const,
        selected: null,
        options: s.options,
      };
    case 'INVALID_CODE':
      return {
        status: 'INVALID_METHOD' as const,
        selected: null,
        options: s.options,
      };
    case 'SELECTED':
      return {
        status: 'SELECTED' as const,
        selected: s.option.code,
        options: s.options,
      };
  }
}

export { ErrorCode };
