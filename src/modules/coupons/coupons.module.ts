import { Module } from '@nestjs/common';
import { CouponService } from './coupon.service.js';
import { CouponsAdminController } from './coupons-admin.controller.js';

@Module({
  controllers: [CouponsAdminController],
  providers: [CouponService],
  exports: [CouponService],
})
export class CouponsModule {}
