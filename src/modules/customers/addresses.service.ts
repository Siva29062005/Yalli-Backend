import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import type {
  CreateAddressDto,
  UpdateAddressDto,
} from './dto/customer.schemas.js';

export const MAX_ADDRESSES = 20;

const PUBLIC_FIELDS = {
  id: true,
  label: true,
  fullName: true,
  phoneE164: true,
  line1: true,
  line2: true,
  landmark: true,
  city: true,
  state: true,
  postalCode: true,
  countryCode: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Address book. EVERY query is scoped to the caller's userId: another user's address id behaves like a missing one (404). */
@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(principal: AuthPrincipal) {
    return this.prisma.address.findMany({
      where: { userId: principal.userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: PUBLIC_FIELDS,
    });
  }

  async get(principal: AuthPrincipal, id: string) {
    const a = await this.prisma.address.findFirst({
      where: { id, userId: principal.userId, deletedAt: null },
      select: PUBLIC_FIELDS,
    });
    if (!a) throw new NotFoundException('Address not found');
    return a;
  }

  async create(
    principal: AuthPrincipal,
    dto: CreateAddressDto,
    ctx: RequestContext,
  ) {
    const address = await this.prisma.$transaction(async (tx) => {
      const count = await tx.address.count({
        where: { userId: principal.userId, deletedAt: null },
      });
      if (count >= MAX_ADDRESSES)
        throw new ConflictException({
          message: `You can save up to ${MAX_ADDRESSES} addresses`,
          code: ErrorCode.Conflict,
        });
      const makeDefault = dto.isDefault === true || count === 0; // the first address is the default
      if (makeDefault)
        await tx.address.updateMany({
          where: { userId: principal.userId, isDefault: true },
          data: { isDefault: false },
        });
      return tx.address.create({
        data: {
          userId: principal.userId,
          label: dto.label ?? null,
          fullName: dto.fullName,
          phoneE164: dto.phone,
          line1: dto.line1,
          line2: dto.line2 ?? null,
          landmark: dto.landmark ?? null,
          city: dto.city,
          state: dto.state,
          postalCode: dto.postalCode,
          isDefault: makeDefault,
        },
        select: PUBLIC_FIELDS,
      });
    });
    await this.audit.record({
      action: AuditAction.AddressCreated,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'address',
      resourceId: address.id,
    });
    return address;
  }

  async update(
    principal: AuthPrincipal,
    id: string,
    dto: UpdateAddressDto,
    ctx: RequestContext,
  ) {
    const address = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.address.findFirst({
        where: { id, userId: principal.userId, deletedAt: null },
        select: { id: true, isDefault: true },
      });
      if (!existing) throw new NotFoundException('Address not found');
      if (dto.isDefault === false && existing.isDefault) {
        throw new ConflictException({
          message:
            'Choose another default address instead of unsetting this one',
          code: ErrorCode.Conflict,
        });
      }
      if (dto.isDefault === true && !existing.isDefault) {
        await tx.address.updateMany({
          where: { userId: principal.userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      const { phone, ...rest } = dto;
      return tx.address.update({
        where: { id: existing.id },
        data: { ...rest, ...(phone !== undefined ? { phoneE164: phone } : {}) },
        select: PUBLIC_FIELDS,
      });
    });
    await this.audit.record({
      action: AuditAction.AddressUpdated,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'address',
      resourceId: id,
    });
    return address;
  }

  async setDefault(principal: AuthPrincipal, id: string, ctx: RequestContext) {
    return this.update(principal, id, { isDefault: true }, ctx);
  }

  /** Soft delete. If it was the default, the most recently created remaining address becomes the default. */
  async remove(
    principal: AuthPrincipal,
    id: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.address.findFirst({
        where: { id, userId: principal.userId, deletedAt: null },
        select: { id: true, isDefault: true },
      });
      if (!existing) throw new NotFoundException('Address not found');
      await tx.address.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), isDefault: false },
      });
      if (existing.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId: principal.userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (next)
          await tx.address.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
      }
    });
    await this.audit.record({
      action: AuditAction.AddressDeleted,
      outcome: 'SUCCESS',
      actorId: principal.userId,
      ...ctx,
      resourceType: 'address',
      resourceId: id,
    });
  }
}
