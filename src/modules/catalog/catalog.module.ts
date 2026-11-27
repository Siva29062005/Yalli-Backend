import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogQueryService } from './catalog-query.service.js';
import { MediaController } from './media.controller.js';
import { ProductRatings } from './product-ratings.js';
import { CatalogImportService } from './import/catalog-import.service.js';
import { LocalDiskStorage, ObjectStorage } from './media/object-storage.js';

@Module({
  imports: [InventoryModule],
  controllers: [CatalogController, CatalogAdminController, MediaController],
  providers: [
    CatalogQueryService,
    CatalogAdminService,
    CatalogImportService,
    ProductRatings,
    { provide: ObjectStorage, useClass: LocalDiskStorage },
  ],
  exports: [CatalogQueryService, CatalogImportService, ProductRatings],
})
export class CatalogModule {}
