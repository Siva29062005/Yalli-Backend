import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CommerceModule } from '../orders/commerce.module.js';
import { AdminAccessController } from './admin-access.controller.js';
import { AdminAccessService } from './admin-access.service.js';
import { AuditLogController } from './audit-log.controller.js';
import { CustomerLookupController } from './customer-lookup.controller.js';
import { CustomerLookupService } from './customer-lookup.service.js';

@Module({
  imports: [AccessModule, IdentityModule, CommerceModule],
  controllers: [
    AdminAccessController,
    CustomerLookupController,
    AuditLogController,
  ],
  providers: [AdminAccessService, CustomerLookupService],
})
export class AdminModule {}
