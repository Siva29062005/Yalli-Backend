import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AccountService } from './account.service.js';
import { AddressesService } from './addresses.service.js';
import { CustomersController } from './customers.controller.js';

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [CustomersController],
  providers: [AccountService, AddressesService],
  exports: [AddressesService],
})
export class CustomersModule {}
