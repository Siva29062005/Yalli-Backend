import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
  OptionalAuth,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { MAX_LINE_QUANTITY } from '../pricing/cart-pricing.js';
import { CartService, type CartOwner } from './cart.service.js';

export const CART_TOKEN_HEADER = 'x-cart-token';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** A malformed guest token is a client error (400), never a server error. */
function cartToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!TOKEN_FORMAT.test(value))
    throw new BadRequestException({
      message: 'Malformed cart token',
      code: 'BAD_REQUEST',
    });
  return value;
}
const quantity = z.number().int().min(1).max(MAX_LINE_QUANTITY);
const addSchema = z
  .object({ variantId: z.uuid(), quantity: quantity.default(1) })
  .strict();
const qtySchema = z.object({ quantity }).strict();
const couponSchema = z
  .object({ code: z.string().trim().min(3).max(40) })
  .strict();

const owner = (req: Request, guestToken: string | undefined): CartOwner => ({
  principal: req.auth,
  guestToken: req.auth ? undefined : guestToken,
});

/**
 * Cart for guests (X-Cart-Token header, returned on first add) and signed-in users (bearer token).
 * Header-based identification means there is no ambient credential for a cross-site request to abuse.
 */
@ApiTags('cart')
@Controller('cart')
@RateLimit({ name: 'cart', limit: 120, windowSeconds: 60, key: 'ip' })
export class CartController {
  constructor(private readonly cart: CartService) {}

  @OptionalAuth()
  @Get()
  get(@Req() req: Request, @Headers(CART_TOKEN_HEADER) t?: string) {
    return this.cart.get(owner(req, cartToken(t)));
  }

  @OptionalAuth()
  @Post('items')
  @ResponseMessage('Added to cart')
  add(
    @Req() req: Request,
    @Body({ schema: addSchema }) dto: z.infer<typeof addSchema>,
    @Headers(CART_TOKEN_HEADER) t?: string,
  ) {
    return this.cart.addItem(
      owner(req, cartToken(t)),
      dto.variantId,
      dto.quantity,
    );
  }

  @OptionalAuth()
  @Patch('items/:variantId')
  update(
    @Req() req: Request,
    @Param('variantId', { schema: z.uuid() }) variantId: string,
    @Body({ schema: qtySchema }) dto: z.infer<typeof qtySchema>,
    @Headers(CART_TOKEN_HEADER) t?: string,
  ) {
    return this.cart.setQuantity(
      owner(req, cartToken(t)),
      variantId,
      dto.quantity,
    );
  }

  @OptionalAuth()
  @Delete('items/:variantId')
  remove(
    @Req() req: Request,
    @Param('variantId', { schema: z.uuid() }) variantId: string,
    @Headers(CART_TOKEN_HEADER) t?: string,
  ) {
    return this.cart.removeItem(owner(req, cartToken(t)), variantId);
  }

  @OptionalAuth()
  @Delete()
  clear(@Req() req: Request, @Headers(CART_TOKEN_HEADER) t?: string) {
    return this.cart.clear(owner(req, cartToken(t)));
  }

  @OptionalAuth()
  @Post('coupon')
  @HttpCode(200)
  @ResponseMessage('Coupon applied')
  // Tight limit: coupon codes must not be brute-forceable.
  @RateLimit({ name: 'coupon-apply', limit: 10, windowSeconds: 600, key: 'ip' })
  applyCoupon(
    @Req() req: Request,
    @Body({ schema: couponSchema }) dto: z.infer<typeof couponSchema>,
    @Headers(CART_TOKEN_HEADER) t?: string,
  ) {
    return this.cart.applyCoupon(owner(req, cartToken(t)), dto.code);
  }

  @OptionalAuth()
  @Delete('coupon')
  removeCoupon(@Req() req: Request, @Headers(CART_TOKEN_HEADER) t?: string) {
    return this.cart.removeCoupon(owner(req, cartToken(t)));
  }

  /** After sign-in: fold the guest cart into the user's cart. */
  @Authenticated()
  @Post('merge')
  @HttpCode(200)
  @ResponseMessage('Cart merged')
  merge(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Headers(CART_TOKEN_HEADER) t?: string,
  ) {
    const guest = cartToken(t);
    if (!guest) throw new UnauthorizedException('Missing guest cart token');
    return this.cart.merge(principal, guest);
  }
}
