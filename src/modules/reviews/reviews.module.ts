import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CommerceModule } from '../orders/commerce.module.js';
import {
  MyReviewsController,
  ProductReviewsController,
  ReviewsAdminController,
  WishlistController,
} from './reviews.controllers.js';
import { ReviewsService } from './reviews.service.js';
import { WishlistService } from './wishlist.service.js';

@Module({
  imports: [CatalogModule, CommerceModule],
  controllers: [
    ProductReviewsController,
    MyReviewsController,
    ReviewsAdminController,
    WishlistController,
  ],
  providers: [ReviewsService, WishlistService],
  exports: [ReviewsService, WishlistService],
})
export class ReviewsModule {}
