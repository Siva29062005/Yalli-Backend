import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ContactAdminController } from './contact-admin.controller.js';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [ContactController, ContactAdminController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}
