import { Global, Module } from '@nestjs/common';
import { AuditReader } from './audit-reader.service.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  providers: [AuditService, AuditReader],
  exports: [AuditService, AuditReader],
})
export class AuditModule {}
