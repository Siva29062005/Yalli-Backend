import { Module } from '@nestjs/common';
import { ShippingAdminController } from './shipping-admin.controller.js';
import { ShippingService } from './shipping.service.js';

@Module({
  controllers: [ShippingAdminController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
