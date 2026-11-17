import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service.js';
import { SeedService } from './seed.service.js';

@Module({
  providers: [AuthorizationService, SeedService],
  exports: [AuthorizationService, SeedService],
})
export class AccessModule {}
