import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogQueryService } from './catalog-query.service.js';
import { MediaController } from './media.controller.js';
import { ProductRatings } from './product-ratings.js';
import { CatalogImportController } from './import/catalog-import.controller.js';
import { CatalogImportService } from './import/catalog-import.service.js';
import {
  LocalDiskStorage,
  ObjectStorage,
  S3Storage,
} from './media/object-storage.js';

@Module({
  imports: [InventoryModule],
  controllers: [
    CatalogController,
    CatalogAdminController,
    MediaController,
    CatalogImportController,
  ],
  providers: [
    CatalogQueryService,
    CatalogAdminService,
    CatalogImportService,
    ProductRatings,
    {
      provide: ObjectStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('STORAGE_DRIVER', { infer: true }) === 's3'
          ? new S3Storage(config)
          : new LocalDiskStorage(config),
    },
  ],
  exports: [CatalogQueryService, CatalogImportService, ProductRatings],
})
export class CatalogModule {}
