import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AdminAccessController } from './admin-access.controller.js';
import { AdminAccessService } from './admin-access.service.js';

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [AdminAccessController],
  providers: [AdminAccessService],
})
export class AdminModule {}
