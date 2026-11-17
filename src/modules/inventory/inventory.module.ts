import { Module } from '@nestjs/common';
import { InventoryAdminController } from './inventory-admin.controller.js';
import { InventorySweeper } from './inventory-sweeper.js';
import { InventoryService } from './inventory.service.js';

@Module({
  controllers: [InventoryAdminController],
  providers: [InventoryService, InventorySweeper],
  exports: [InventoryService],
})
export class InventoryModule {}
