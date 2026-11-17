import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CatalogQueryService } from '../catalog/catalog-query.service.js';
import {
  CouponService,
  normalizeCouponCode,
} from '../coupons/coupon.service.js';
import { generateToken, sha256Hex } from '../identity/crypto/token-utils.js';
import { InventoryService } from '../inventory/inventory.service.js';
import {
  MAX_LINE_QUANTITY,
  priceCart,
  type PricingLine,
} from '../pricing/cart-pricing.js';
import { CURRENCY } from '../pricing/money.js';
import { effectivePrice } from '../pricing/price.js';

type Tx = Prisma.TransactionClient;

export const MAX_CART_LINES = 50;
const GUEST_TTL_DAYS = 30;
const USER_TTL_DAYS = 90;
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

export interface CartOwner {
  principal: AuthPrincipal | undefined;
  guestToken: string | undefined;
}

type LineIssue = 'UNAVAILABLE' | 'INSUFFICIENT_STOCK' | null;

/**
 * Carts never store prices: every view re-prices from the catalogue with the pure pricing engine, so a client can
 * never influence what it pays. Guest carts are addressed by an opaque 256-bit token (stored hashed); user carts by
 * the authenticated user id. Buying requires signing in (checkout, Phase 5); guest carts merge on login.
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly coupons: CouponService,
    private readonly catalog: CatalogQueryService,
  ) {}

  // -------------------------------------------------------------------------------- resolution

  private async find(owner: CartOwner) {
    if (owner.principal)
      return this.prisma.cart.findUnique({
        where: { userId: owner.principal.userId },
      });
    if (!owner.guestToken) return null;
    return this.prisma.cart.findFirst({
      where: {
        guestTokenHash: sha256Hex(owner.guestToken),
        expiresAt: { gt: new Date() },
      },
    });
  }

  /** Finds or creates the caller's cart. A brand-new guest cart comes with its token (shown to the client once). */
  private async findOrCreate(
    owner: CartOwner,
  ): Promise<{ id: string; issuedToken?: string }> {
    const existing = await this.find(owner);
    if (existing) {
      await this.prisma.cart.update({
        where: { id: existing.id },
        data: {
          expiresAt: days(owner.principal ? USER_TTL_DAYS : GUEST_TTL_DAYS),
        },
      });
      return { id: existing.id };
    }
    if (owner.principal) {
      const cart = await this.prisma.cart.upsert({
        where: { userId: owner.principal.userId },
        update: {},
        create: {
          userId: owner.principal.userId,
          expiresAt: days(USER_TTL_DAYS),
        },
      });
      return { id: cart.id };
    }
    const token = generateToken();
    const cart = await this.prisma.cart.create({
      data: {
        guestTokenHash: sha256Hex(token),
        expiresAt: days(GUEST_TTL_DAYS),
      },
    });
    return { id: cart.id, issuedToken: token };
  }

  /** Serialises concurrent edits of ONE cart (two tabs adding the same item cannot exceed the limits). */
  private lockCart(tx: Tx, cartId: string) {
    return tx.$queryRaw`SELECT id FROM carts WHERE id = ${cartId}::uuid FOR UPDATE`;
  }

  private async purchasableVariant(variantId: string) {
    const v = await this.prisma.productVariant.findFirst({
      where: {
        id: variantId,
        isActive: true,
        deletedAt: null,
        product: { status: 'PUBLISHED', deletedAt: null },
      },
      select: { id: true },
    });
    if (!v)
      throw new NotFoundException({
        message: 'This item is not available',
        code: ErrorCode.NotFound,
      });
    return v;
  }

  // -------------------------------------------------------------------------------- mutations

  async addItem(owner: CartOwner, variantId: string, quantity: number) {
    await this.purchasableVariant(variantId);
    const cart = await this.findOrCreate(owner);
    const available =
      (await this.inventory.availability([variantId])).get(variantId)
        ?.available ?? 0;
    await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cart.id);
      const line = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId } },
      });
      const next = (line?.quantity ?? 0) + quantity;
      if (
        !line &&
        (await tx.cartItem.count({ where: { cartId: cart.id } })) >=
          MAX_CART_LINES
      ) {
        throw new ConflictException({
          message: `A cart can hold up to ${MAX_CART_LINES} different items`,
          code: 'CART_FULL',
        });
      }
      this.assertQuantity(next, available);
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId } },
        update: { quantity: next },
        create: { cartId: cart.id, variantId, quantity: next },
      });
    });
    return this.view(cart.id, owner, cart.issuedToken);
  }

  async setQuantity(owner: CartOwner, variantId: string, quantity: number) {
    const cart = await this.requireCart(owner);
    const available =
      (await this.inventory.availability([variantId])).get(variantId)
        ?.available ?? 0;
    await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cart.id);
      const line = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId } },
      });
      if (!line) throw new NotFoundException('Item is not in your cart');
      this.assertQuantity(quantity, available);
      await tx.cartItem.update({ where: { id: line.id }, data: { quantity } });
    });
    return this.view(cart.id, owner);
  }

  async removeItem(owner: CartOwner, variantId: string) {
    const cart = await this.requireCart(owner);
    const res = await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, variantId },
    });
    if (res.count === 0)
      throw new NotFoundException('Item is not in your cart');
    return this.view(cart.id, owner);
  }

  async clear(owner: CartOwner) {
    const cart = await this.find(owner);
    if (cart)
      await this.prisma.$transaction([
        this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
        this.prisma.cart.update({
          where: { id: cart.id },
          data: { couponCode: null },
        }),
      ]);
    return cart ? this.view(cart.id, owner) : this.emptyView();
  }

  async applyCoupon(owner: CartOwner, rawCode: string) {
    const cart = await this.requireCart(owner);
    const coupon = await this.coupons.findByCode(rawCode);
    // Unknown, inactive, expired and not-yet-started all look the same (no coupon-code enumeration).
    const reason = coupon
      ? await this.coupons.unusableReason(
          coupon,
          owner.principal?.userId ?? null,
        )
      : 'INVALID';
    if (!coupon || reason === 'INVALID')
      throw new BadRequestException({
        message: 'This coupon code is not valid',
        code: 'COUPON_INVALID',
      });
    if (reason === 'EXHAUSTED')
      throw new ConflictException({
        message: 'This coupon is no longer available',
        code: 'COUPON_UNAVAILABLE',
      });
    if (reason === 'CUSTOMER_LIMIT')
      throw new ConflictException({
        message: 'You have already used this coupon',
        code: 'COUPON_CUSTOMER_LIMIT',
      });
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: coupon.code },
    });
    const view = await this.view(cart.id, owner);
    if (view.couponError) {
      await this.prisma.cart.update({
        where: { id: cart.id },
        data: { couponCode: null },
      });
      const messages: Record<string, string> = {
        MIN_CART_VALUE: 'Add more items to use this coupon',
        NO_ELIGIBLE_ITEMS:
          'This coupon does not apply to the items in your cart',
      };
      throw new BadRequestException({
        message: messages[view.couponError] ?? 'This coupon cannot be applied',
        code: `COUPON_${view.couponError}`,
      });
    }
    return view;
  }

  async removeCoupon(owner: CartOwner) {
    const cart = await this.requireCart(owner);
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: null },
    });
    return this.view(cart.id, owner);
  }

  /**
   * Moves a guest cart into the signed-in user's cart. Quantities add up, capped by the per-line limit and current
   * stock; the user's own coupon wins over the guest's. The guest cart (and its token) is destroyed.
   */
  async merge(principal: AuthPrincipal, guestToken: string) {
    const guest = await this.prisma.cart.findFirst({
      where: {
        guestTokenHash: sha256Hex(guestToken),
        expiresAt: { gt: new Date() },
      },
      include: { items: true },
    });
    const target = await this.findOrCreate({
      principal,
      guestToken: undefined,
    });
    if (!guest)
      return this.view(target.id, { principal, guestToken: undefined });
    const stock = await this.inventory.availability(
      guest.items.map((i) => i.variantId),
    );
    await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, target.id);
      const userCart = await tx.cart.findUniqueOrThrow({
        where: { id: target.id },
        include: { items: true },
      });
      for (const item of guest.items) {
        const existing = userCart.items.find(
          (i) => i.variantId === item.variantId,
        );
        if (!existing && userCart.items.length >= MAX_CART_LINES) break;
        const cap = Math.min(
          MAX_LINE_QUANTITY,
          Math.max(
            stock.get(item.variantId)?.available ?? 0,
            existing?.quantity ?? 0,
            1,
          ),
        );
        const qty = Math.min((existing?.quantity ?? 0) + item.quantity, cap);
        await tx.cartItem.upsert({
          where: {
            cartId_variantId: { cartId: target.id, variantId: item.variantId },
          },
          update: { quantity: qty },
          create: {
            cartId: target.id,
            variantId: item.variantId,
            quantity: qty,
          },
        });
      }
      if (!userCart.couponCode && guest.couponCode)
        await tx.cart.update({
          where: { id: target.id },
          data: { couponCode: guest.couponCode },
        });
      await tx.cart.delete({ where: { id: guest.id } });
    });
    return this.view(target.id, { principal, guestToken: undefined });
  }

  async get(owner: CartOwner) {
    const cart = await this.find(owner);
    return cart ? this.view(cart.id, owner) : this.emptyView();
  }

  // -------------------------------------------------------------------------------- pricing

  private assertQuantity(quantity: number, available: number) {
    if (quantity > MAX_LINE_QUANTITY)
      throw new ConflictException({
        message: `You can buy up to ${MAX_LINE_QUANTITY} of an item`,
        code: 'QUANTITY_LIMIT',
      });
    if (quantity > available)
      throw new ConflictException({
        message:
          available > 0
            ? `Only ${Math.min(available, MAX_LINE_QUANTITY)} available`
            : 'This item is out of stock',
        code: 'INSUFFICIENT_STOCK',
      });
  }

  private async requireCart(owner: CartOwner) {
    const cart = await this.find(owner);
    if (!cart) throw new NotFoundException('Your cart is empty');
    return cart;
  }

  private emptyView() {
    return {
      items: [],
      itemCount: 0,
      coupon: null,
      couponError: null,
      totals: {
        subtotalMinor: 0,
        discountMinor: 0,
        shippingMinor: 0,
        gstIncludedMinor: 0,
        totalMinor: 0,
        currency: CURRENCY,
      },
    };
  }

  /** Re-prices the whole cart from live catalogue data. Lines that can no longer be bought are flagged and excluded. */
  async view(cartId: string, owner: CartOwner, issuedToken?: string) {
    const cart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cartId },
      include: {
        items: {
          orderBy: { addedAt: 'asc' },
          include: {
            variant: {
              include: {
                product: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                    status: true,
                    deletedAt: true,
                    gstRateBps: true,
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
    const stock = await this.inventory.availability(
      cart.items.map((i) => i.variantId),
    );
    const now = new Date();

    const lines = cart.items.map((item) => {
      const v = item.variant;
      const live =
        v.isActive &&
        !v.deletedAt &&
        v.product.status === 'PUBLISHED' &&
        !v.product.deletedAt;
      const available = stock.get(v.id)?.available ?? 0;
      const issue: LineIssue = !live
        ? 'UNAVAILABLE'
        : available < item.quantity
          ? 'INSUFFICIENT_STOCK'
          : null;
      return { item, v, price: effectivePrice(v, now), issue, available };
    });

    const purchasable = lines.filter((l) => l.issue === null);
    const pricingLines: PricingLine[] = purchasable.map((l) => ({
      key: l.v.id,
      productId: l.v.product.id,
      categoryIds: l.v.product.categories.map((c) => c.categoryId),
      unitPriceMinor: l.price.unitPriceMinor,
      quantity: l.item.quantity,
      gstRateBps: l.v.product.gstRateBps,
    }));

    let rule = null;
    let couponError: string | null = null;
    if (cart.couponCode) {
      const coupon = await this.coupons.findByCode(cart.couponCode);
      const reason = coupon
        ? await this.coupons.unusableReason(
            coupon,
            owner.principal?.userId ?? null,
          )
        : 'INVALID';
      if (coupon && reason === null) rule = this.coupons.toRule(coupon);
      else couponError = reason ?? 'INVALID';
    }
    const priced = priceCart(pricingLines, rule);
    if (priced.couponRejection) couponError = priced.couponRejection;
    const byKey = new Map(priced.lines.map((l) => [l.key, l]));

    return {
      ...(issuedToken ? { cartToken: issuedToken } : {}),
      items: lines.map((l) => {
        const p = byKey.get(l.v.id);
        return {
          variantId: l.v.id,
          sku: l.v.sku,
          productId: l.v.product.id,
          productSlug: l.v.product.slug,
          productName: l.v.product.name,
          variantName: l.v.name,
          imageUrl: this.catalog.imageUrl(
            l.v.product.images[0]?.storageKey ?? null,
          ),
          quantity: l.item.quantity,
          unitPriceMinor: l.price.unitPriceMinor,
          compareAtMinor: l.price.compareAtMinor,
          lineSubtotalMinor: p?.subtotalMinor ?? 0,
          lineDiscountMinor: p?.discountMinor ?? 0,
          lineTotalMinor: p?.totalMinor ?? 0,
          purchasable: l.issue === null,
          issue: l.issue,
          maxQuantity: Math.max(0, Math.min(MAX_LINE_QUANTITY, l.available)),
        };
      }),
      itemCount: purchasable.reduce((n, l) => n + l.item.quantity, 0),
      coupon: priced.coupon
        ? {
            code: priced.coupon.code,
            discountMinor: priced.coupon.discountMinor,
          }
        : cart.couponCode && couponError
          ? { code: normalizeCouponCode(cart.couponCode), discountMinor: 0 }
          : null,
      couponError,
      totals: {
        subtotalMinor: priced.subtotalMinor,
        discountMinor: priced.discountMinor,
        shippingMinor: priced.shippingMinor,
        gstIncludedMinor: priced.gstIncludedMinor,
        totalMinor: priced.totalMinor,
        currency: CURRENCY,
      },
    };
  }

  /** Housekeeping: delete abandoned guest carts. */
  async purgeExpired(): Promise<number> {
    return (
      await this.prisma.cart.deleteMany({
        where: { expiresAt: { lte: new Date() }, userId: null },
      })
    ).count;
  }
}
