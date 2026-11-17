import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { requestContext } from '../audit/audit.service.js';
import { AccountService } from './account.service.js';
import { AddressesService } from './addresses.service.js';
import {
  createAddressSchema,
  reauthSchema,
  updateAddressSchema,
  updateProfileSchema,
  uuidParam,
  type CreateAddressDto,
  type UpdateAddressDto,
} from './dto/customer.schemas.js';

@ApiTags('me')
@Controller('me')
@Authenticated()
export class CustomersController {
  constructor(
    private readonly account: AccountService,
    private readonly addresses: AddressesService,
  ) {}

  @Patch()
  @ResponseMessage('Profile updated')
  updateProfile(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body({ schema: updateProfileSchema })
    dto: z.infer<typeof updateProfileSchema>,
    @Req() req: Request,
  ) {
    return this.account.updateProfile(p, dto, requestContext(req));
  }

  @Post('export')
  @HttpCode(200)
  @ResponseMessage('Your data export')
  @RateLimit({
    name: 'data-export',
    limit: 3,
    windowSeconds: 86_400,
    key: 'principal',
  })
  export(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body({ schema: reauthSchema }) dto: z.infer<typeof reauthSchema>,
    @Req() req: Request,
  ) {
    return this.account.exportData(
      p,
      dto.password,
      dto.code,
      requestContext(req),
    );
  }

  @Delete()
  @HttpCode(200)
  @ResponseMessage('Your account has been deleted')
  @RateLimit({
    name: 'account-delete',
    limit: 5,
    windowSeconds: 3_600,
    key: 'principal',
  })
  async deleteAccount(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body({ schema: reauthSchema }) dto: z.infer<typeof reauthSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.deleteAccount(
      p,
      dto.password,
      dto.code,
      requestContext(req),
    );
    return null;
  }

  @Get('addresses')
  listAddresses(@CurrentPrincipal() p: AuthPrincipal) {
    return this.addresses.list(p);
  }

  @Get('addresses/:id')
  getAddress(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.addresses.get(p, id);
  }

  @Post('addresses')
  @ResponseMessage('Address saved')
  @RateLimit({
    name: 'address-write',
    limit: 30,
    windowSeconds: 3_600,
    key: 'principal',
  })
  createAddress(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body({ schema: createAddressSchema }) dto: CreateAddressDto,
    @Req() req: Request,
  ) {
    return this.addresses.create(p, dto, requestContext(req));
  }

  @Patch('addresses/:id')
  @ResponseMessage('Address updated')
  @RateLimit({
    name: 'address-write',
    limit: 30,
    windowSeconds: 3_600,
    key: 'principal',
  })
  updateAddress(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateAddressSchema }) dto: UpdateAddressDto,
    @Req() req: Request,
  ) {
    return this.addresses.update(p, id, dto, requestContext(req));
  }

  @Put('addresses/:id/default')
  @ResponseMessage('Default address updated')
  setDefault(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ) {
    return this.addresses.setDefault(p, id, requestContext(req));
  }

  @Delete('addresses/:id')
  @HttpCode(200)
  @ResponseMessage('Address removed')
  async removeAddress(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.addresses.remove(p, id, requestContext(req));
    return null;
  }
}
