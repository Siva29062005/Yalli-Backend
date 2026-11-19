import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
} from '../../common/decorators/access.decorators.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own identity. Fields are an explicit allow-list: no hashes, tokens or internal flags. */
  @Authenticated()
  @Get()
  async me(@CurrentPrincipal() principal: AuthPrincipal) {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: {
        id: true,
        email: true,
        phoneE164: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        mfaEnabled: true,
        createdAt: true,
        customer: {
          select: {
            firstName: true,
            lastName: true,
            newsletterSubscribed: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException();
    return {
      id: user.id,
      email: user.email,
      phone: user.phoneE164,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      mfaEnabled: user.mfaEnabled,
      firstName: user.customer?.firstName ?? null,
      lastName: user.customer?.lastName ?? null,
      newsletterSubscribed: user.customer?.newsletterSubscribed ?? false,
      roles: principal.roles.map((r) => r.name),
      // The caller's OWN effective permissions (from the database, never the token): lets the staff UI hide screens it
      // cannot use. Hiding is cosmetic; every route still enforces its permission on the server.
      permissions: [...principal.permissions].sort(),
      createdAt: user.createdAt,
    };
  }
}
