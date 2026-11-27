import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [ContactController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}
