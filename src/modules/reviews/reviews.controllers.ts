import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
  Public,
  RequirePermissions,
  RequireStepUp,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { paginationSchema } from '../../common/http/pagination.js';
import { Permission } from '../access/permissions.js';
import { requestContext } from '../audit/audit.service.js';
import { slugParam } from '../catalog/dto/catalog.schemas.js';
import { ReviewsService } from './reviews.service.js';
import { WishlistService } from './wishlist.service.js';

const uuid = z.uuid();
const reviewFields = {
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).nullable().optional(),
  body: z.string().trim().min(10).max(2000),
};
const createSchema = z.object(reviewFields).strict();
const updateSchema = z
  .object({
    rating: reviewFields.rating.optional(),
    title: reviewFields.title,
    body: reviewFields.body.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
/** Taking a published review down always needs a reason (the author sees it). */
const takeDownSchema = z
  .object({ note: z.string().trim().min(3).max(300) })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().min(3).max(300).optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'REJECTED' || !!v.note, {
    message: 'A reason is required when rejecting',
    path: ['note'],
  });
const adminListSchema = paginationSchema
  .extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() })
  .strict();

// ----------------------------------------------------------------------------------------- public + customer

@ApiTags('reviews')
@Controller('catalog/products/:slug/reviews')
export class ProductReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @Public()
  list(
    @Param('slug', { schema: slugParam }) slug: string,
    @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>,
  ) {
    return this.reviews.listForProduct(slug, q);
  }

  @Get('summary')
  @Public()
  summary(@Param('slug', { schema: slugParam }) slug: string) {
    return this.reviews.summary(slug);
  }

  @Post()
  @Authenticated()
  @HttpCode(201)
  @ResponseMessage('Thanks! Your review will appear once it has been checked.')
  @RateLimit({
    name: 'review-create',
    limit: 10,
    windowSeconds: 3_600,
    key: 'principal',
  })
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('slug', { schema: slugParam }) slug: string,
    @Body({ schema: createSchema }) dto: z.infer<typeof createSchema>,
  ) {
    return this.reviews.create(p, slug, dto);
  }
}

@ApiTags('reviews')
@Controller('me/reviews')
@Authenticated()
export class MyReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>,
  ) {
    return this.reviews.listOwn(p, q);
  }

  @Patch(':id')
  @ResponseMessage('Review updated. It will be checked again before it shows.')
  @RateLimit({
    name: 'review-update',
    limit: 20,
    windowSeconds: 3_600,
    key: 'principal',
  })
  update(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: updateSchema }) dto: z.infer<typeof updateSchema>,
  ) {
    return this.reviews.updateOwn(p, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ResponseMessage('Review removed')
  async remove(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
  ): Promise<null> {
    await this.reviews.removeOwn(p, id);
    return null;
  }
}

// ------------------------------------------------------------------------------------------------- admin

@ApiTags('admin-reviews')
@Controller('admin/reviews')
@RequireStepUp(1800)
@RequirePermissions(Permission.ReviewsModerate)
@RateLimit({
  name: 'admin-reviews',
  limit: 120,
  windowSeconds: 60,
  key: 'principal',
})
export class ReviewsAdminController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Query({ schema: adminListSchema }) q: z.infer<typeof adminListSchema>) {
    return this.reviews.adminList(q);
  }

  @Post(':id/take-down')
  @HttpCode(200)
  takeDown(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: takeDownSchema }) dto: z.infer<typeof takeDownSchema>,
    @Req() req: Request,
  ) {
    return this.reviews.takeDown(a, id, dto.note, requestContext(req));
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: decisionSchema }) dto: z.infer<typeof decisionSchema>,
    @Req() req: Request,
  ) {
    return this.reviews.decide(
      a,
      id,
      dto.decision,
      dto.note,
      requestContext(req),
    );
  }
}

// ----------------------------------------------------------------------------------------------- wishlist

@ApiTags('wishlist')
@Controller('me/wishlist')
@Authenticated()
@RateLimit({
  name: 'wishlist',
  limit: 120,
  windowSeconds: 60,
  key: 'principal',
})
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get()
  list(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>,
  ) {
    return this.wishlist.list(p, q);
  }

  @Put(':slug')
  @HttpCode(200)
  add(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('slug', { schema: slugParam }) slug: string,
  ) {
    return this.wishlist.add(p, slug);
  }

  @Delete(':slug')
  @HttpCode(200)
  @ResponseMessage('Removed from your wishlist')
  async remove(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('slug', { schema: slugParam }) slug: string,
  ): Promise<null> {
    await this.wishlist.remove(p, slug);
    return null;
  }
}
