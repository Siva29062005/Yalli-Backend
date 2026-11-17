import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, type RequestContext } from '../audit/audit.service.js';
import {
  canMoveShipment,
  chooseShipping,
  shippingOptions,
  type ShipmentStatusName,
  type ShippingChoice,
  type ShippingMethodRule,
} from './shipping-rules.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface ShippingMethodInput {
  code: string;
  name: string;
  description?: string | null | undefined;
  baseMinor: number;
  freeAboveMinor?: number | null | undefined;
  etaMinDays: number;
  etaMaxDays: number;
  states?: string[] | undefined;
  sortOrder?: number | undefined;
  isActive?: boolean | undefined;
}

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002';

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------------------------ pricing

  private async activeRules(
    db: Db,
  ): Promise<{ rules: ShippingMethodRule[]; count: number }> {
    const rows = await db.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return {
      count: rows.length,
      rules: rows.map((m) => ({
        code: m.code,
        name: m.name,
        baseMinor: m.baseMinor,
        freeAboveMinor: m.freeAboveMinor,
        etaMinDays: m.etaMinDays,
        etaMaxDays: m.etaMaxDays,
        states: m.states,
        sortOrder: m.sortOrder,
      })),
    };
  }

  /** The single place a delivery fee is decided. `payableMinor` is the items total AFTER discount. */
  async resolve(
    db: Db,
    input: {
      state: string;
      payableMinor: number;
      requestedCode?: string | undefined;
      mode: 'quote' | 'order';
    },
  ): Promise<ShippingChoice> {
    const { rules, count } = await this.activeRules(db);
    const options = shippingOptions(rules, {
      state: input.state,
      payableMinor: input.payableMinor,
    });
    return chooseShipping(count, options, input.requestedCode, input.mode);
  }

  // ---------------------------------------------------------------------------- admin: methods

  listMethods() {
    return this.prisma.shippingMethod.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async createMethod(
    actor: AuthPrincipal,
    input: ShippingMethodInput,
    ctx: RequestContext,
  ) {
    this.assertEta(input.etaMinDays, input.etaMaxDays);
    try {
      const m = await this.prisma.shippingMethod.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          baseMinor: input.baseMinor,
          freeAboveMinor: input.freeAboveMinor ?? null,
          etaMinDays: input.etaMinDays,
          etaMaxDays: input.etaMaxDays,
          states: input.states ?? [],
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
        },
      });
      await this.audit.record({
        action: AuditAction.ShippingMethodCreated,
        outcome: 'SUCCESS',
        actorId: actor.userId,
        ...ctx,
        resourceType: 'shipping_method',
        resourceId: m.id,
        metadata: { code: m.code, baseMinor: m.baseMinor },
      });
      return m;
    } catch (e) {
      if (isUnique(e))
        throw new ConflictException({
          message: 'A shipping method with this code already exists',
          code: 'SHIPPING_METHOD_EXISTS',
        });
      throw e;
    }
  }

  async updateMethod(
    actor: AuthPrincipal,
    id: string,
    input: Partial<Omit<ShippingMethodInput, 'code'>>,
    ctx: RequestContext,
  ) {
    const current = await this.prisma.shippingMethod.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Shipping method not found');
    this.assertEta(
      input.etaMinDays ?? current.etaMinDays,
      input.etaMaxDays ?? current.etaMaxDays,
    );
    const m = await this.prisma.shippingMethod.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.baseMinor !== undefined
          ? { baseMinor: input.baseMinor }
          : {}),
        ...(input.freeAboveMinor !== undefined
          ? { freeAboveMinor: input.freeAboveMinor }
          : {}),
        ...(input.etaMinDays !== undefined
          ? { etaMinDays: input.etaMinDays }
          : {}),
        ...(input.etaMaxDays !== undefined
          ? { etaMaxDays: input.etaMaxDays }
          : {}),
        ...(input.states !== undefined ? { states: input.states } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: AuditAction.ShippingMethodUpdated,
      outcome: 'SUCCESS',
      actorId: actor.userId,
      ...ctx,
      resourceType: 'shipping_method',
      resourceId: id,
      metadata: { fields: Object.keys(input) },
    });
    return m;
  }

  private assertEta(min: number, max: number): void {
    if (max < min)
      throw new ConflictException({
        message: 'etaMaxDays must be at least etaMinDays',
        code: 'VALIDATION_FAILED',
      });
  }

  // ----------------------------------------------------------------------------------- shipments

  /** Called inside the "mark shipped" transaction. One shipment per order; the carrier+number pair is unique. */
  async createShipmentInTx(
    tx: Prisma.TransactionClient,
    input: { orderId: string; carrier: string; trackingNumber: string },
    actorId: string,
  ) {
    const existing = await tx.shipment.findUnique({
      where: { orderId: input.orderId },
    });
    if (existing) return existing; // re-marking SHIPPED is idempotent
    try {
      const shipment = await tx.shipment.create({
        data: {
          orderId: input.orderId,
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
        },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: 'IN_TRANSIT',
          note: 'Shipped',
          occurredAt: shipment.shippedAt,
          actorId,
        },
      });
      return shipment;
    } catch (e) {
      if (isUnique(e))
        throw new ConflictException({
          message: 'This tracking number is already used by another shipment',
          code: 'TRACKING_NUMBER_IN_USE',
        });
      throw e;
    }
  }

  /**
   * Applies a tracking update inside the caller's (order-locked) transaction. A repeat of the current status is a no-op;
   * going backwards or leaving a terminal state is refused.
   */
  async applyEventInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    input: {
      status: ShipmentStatusName;
      location?: string | undefined;
      note?: string | undefined;
      occurredAt?: Date | undefined;
    },
    actorId: string,
  ): Promise<{ changed: boolean; shipmentId: string }> {
    const shipment = await tx.shipment.findUnique({ where: { orderId } });
    if (!shipment)
      throw new ConflictException({
        message: 'This order has not been shipped yet',
        code: 'NO_SHIPMENT',
      });
    if (shipment.status === input.status)
      return { changed: false, shipmentId: shipment.id };
    if (!canMoveShipment(shipment.status, input.status))
      throw new ConflictException({
        message: `Shipment is ${shipment.status}; cannot move to ${input.status}`,
        code: 'INVALID_SHIPMENT_TRANSITION',
      });
    const at = input.occurredAt ?? new Date();
    if (at.getTime() > Date.now() + 5 * 60_000)
      throw new ConflictException({
        message: 'occurredAt cannot be in the future',
        code: 'VALIDATION_FAILED',
      });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status: input.status,
        location: input.location ?? null,
        note: input.note ?? null,
        occurredAt: at,
        actorId,
      },
    });
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: input.status,
        ...(input.status === 'DELIVERED' ? { deliveredAt: at } : {}),
      },
    });
    return { changed: true, shipmentId: shipment.id };
  }

  /** Customer-safe tracking view (no actor ids). The CALLER has already proven the order belongs to the customer. */
  async trackingFor(orderId: string) {
    const s = await this.prisma.shipment.findUnique({
      where: { orderId },
      include: { events: { orderBy: { occurredAt: 'desc' } } },
    });
    if (!s) return null;
    return {
      carrier: s.carrier,
      trackingNumber: s.trackingNumber,
      status: s.status,
      shippedAt: s.shippedAt,
      deliveredAt: s.deliveredAt,
      events: s.events.map((e) => ({
        status: e.status,
        location: e.location,
        note: e.note,
        occurredAt: e.occurredAt,
      })),
    };
  }
}
