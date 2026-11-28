import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  BadRequestException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  Authenticated,
  CurrentPrincipal,
  Public,
  RequirePermissions,
  RequireStepUp,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import {
  ResponseMessage,
  SkipEnvelope,
} from '../../common/decorators/response.decorators.js';
import { paginated, paginationSchema } from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { Permission } from '../access/permissions.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { toCsv } from '../../common/utils/csv.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService, requestContext } from '../audit/audit.service.js';
import { indianIsoDate } from './gstr1-export.js';
import { REFUND_EXPORT_COLUMNS, refundRows } from './refund-export.js';
import { CheckoutService } from '../checkout/checkout.service.js';
import {
  assertIdempotencyKey,
  IdempotencyService,
} from '../idempotency/idempotency.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { RefundService } from '../refunds/refund.service.js';
import { CreditNoteService } from './credit-note.service.js';
import { OrderService } from './order.service.js';
import { ReturnService } from './return.service.js';

const uuid = z.uuid();
const shippingCode = z.string().regex(/^[A-Z0-9_]{2,30}$/);
const addressSchema = z
  .object({ addressId: z.uuid(), shippingMethodCode: shippingCode.optional() })
  .strict();
const placeSchema = z
  .object({
    addressId: z.uuid(),
    expectedTotalMinor: z.number().int().min(0).max(2_000_000_000).optional(),
    shippingMethodCode: shippingCode.optional(),
  })
  .strict();
const cancelSchema = z
  .object({
    reason: z.string().trim().min(3).max(200).default('Cancelled by customer'),
  })
  .strict();
const confirmSchema = z
  .object({
    razorpay_order_id: z.string().min(6).max(64),
    razorpay_payment_id: z.string().min(6).max(64),
    razorpay_signature: z.string().length(64),
  })
  .strict();
const returnSchema = z
  .object({
    orderItemId: z.uuid(),
    quantity: z.number().int().min(1).max(99),
    reason: z.enum([
      'DEAD_ON_ARRIVAL',
      'FAULTY',
      'ORDER_ERROR',
      'WRONG_ITEM',
      'OTHER',
    ]),
    opened: z.boolean(),
    details: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      !['FAULTY', 'OTHER'].includes(v.reason) || (v.details?.length ?? 0) >= 5,
    { message: 'Please describe the problem', path: ['details'] },
  );

const setIdempotent = (res: Response, replayed: boolean) => {
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
};

// ------------------------------------------------------------------------------------------ checkout

@ApiTags('checkout')
@Controller('checkout')
@Authenticated()
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly idem: IdempotencyService,
  ) {}

  @Post('quote')
  @HttpCode(200)
  @RateLimit({
    name: 'checkout-quote',
    limit: 60,
    windowSeconds: 60,
    key: 'principal',
  })
  quote(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body({ schema: addressSchema }) dto: z.infer<typeof addressSchema>,
  ) {
    return this.checkout.quote(p, dto.addressId, dto.shippingMethodCode);
  }

  /** Creates the order and reserves stock. Requires an Idempotency-Key: a retry (double click, flaky network) returns the same order. */
  @Post('orders')
  @HttpCode(201)
  @ResponseMessage('Order created. Complete the payment to confirm it.')
  @RateLimit({
    name: 'checkout-place',
    limit: 10,
    windowSeconds: 60,
    key: 'principal',
  })
  async place(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body({ schema: placeSchema }) dto: z.infer<typeof placeSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idem.run(
      {
        scope: 'checkout.place',
        actorId: p.userId,
        key: assertIdempotencyKey(key),
        request: dto,
      },
      async () => ({
        status: 201,
        body: await this.checkout.placeOrder(p, dto, requestContext(req)),
      }),
    );
    setIdempotent(res, r.replayed);
    return r.body;
  }
}

// -------------------------------------------------------------------------------------- customer orders

@ApiTags('orders')
@Controller()
@Authenticated()
export class OrdersController {
  constructor(
    private readonly orders: OrderService,
    private readonly payments: PaymentService,
    private readonly returns: ReturnService,
    private readonly idem: IdempotencyService,
    private readonly creditNotes: CreditNoteService,
  ) {}

  @Get('orders')
  list(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>,
  ) {
    return this.orders.listOwn(p, q);
  }

  @Get('orders/:id')
  get(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
  ) {
    return this.orders.getOwn(p, id);
  }

  @Get('orders/:id/tracking')
  tracking(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
  ) {
    return this.orders.trackingOwn(p, id);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @ResponseMessage('Order cancellation processed')
  @RateLimit({
    name: 'order-cancel',
    limit: 10,
    windowSeconds: 3_600,
    key: 'principal',
  })
  async cancel(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: cancelSchema }) dto: z.infer<typeof cancelSchema>,
    @Req() req: Request,
  ) {
    await this.orders.cancel(
      id,
      { type: 'USER', id: p.userId },
      dto.reason,
      requestContext(req),
      p.userId,
    );
    return this.orders.getOwn(p, id);
  }

  @Get('orders/:id/invoice')
  invoice(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
  ) {
    return this.orders.invoice(p, id);
  }

  /** GST credit notes issued against this order's invoice (one per processed refund). */
  @Get('orders/:id/credit-notes')
  creditNotesForOrder(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
  ) {
    return this.creditNotes.forCustomer(p.userId, id);
  }

  /** Starts (or resumes) payment: returns what Razorpay's checkout needs. Idempotent. */
  @Post('orders/:id/payments')
  @HttpCode(200)
  @RateLimit({
    name: 'payment-initiate',
    limit: 20,
    windowSeconds: 3_600,
    key: 'principal',
  })
  async pay(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idem.run(
      {
        scope: 'payment.initiate',
        actorId: p.userId,
        key: assertIdempotencyKey(key),
        request: { id },
      },
      async () => ({
        status: 200,
        body: await this.payments.initiate(p, id, requestContext(req)),
      }),
    );
    setIdempotent(res, r.replayed);
    return r.body;
  }

  /** The browser reports a finished payment. NOT trusted by itself: verified by signature AND by asking the provider. */
  @Post('orders/:id/payments/confirm')
  @HttpCode(200)
  @RateLimit({
    name: 'payment-confirm',
    limit: 30,
    windowSeconds: 3_600,
    key: 'principal',
  })
  confirm(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: confirmSchema }) dto: z.infer<typeof confirmSchema>,
    @Req() req: Request,
  ) {
    return this.payments.confirmCheckout(
      p,
      id,
      {
        providerOrderId: dto.razorpay_order_id,
        providerPaymentId: dto.razorpay_payment_id,
        signature: dto.razorpay_signature,
      },
      requestContext(req),
    );
  }

  @Get('orders/:id/payment-status')
  @RateLimit({
    name: 'payment-status',
    limit: 120,
    windowSeconds: 60,
    key: 'principal',
  })
  status(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
  ) {
    return this.payments.orderPaymentStatus(p, id);
  }

  @Post('orders/:id/returns')
  @ResponseMessage('Return request received')
  @RateLimit({
    name: 'return-request',
    limit: 10,
    windowSeconds: 3_600,
    key: 'principal',
  })
  requestReturn(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: returnSchema }) dto: z.infer<typeof returnSchema>,
    @Req() req: Request,
  ) {
    return this.returns.request(p, id, dto, requestContext(req));
  }

  @Get('returns')
  myReturns(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>,
  ) {
    return this.returns.listOwn(p, q);
  }
}

// ------------------------------------------------------------------------------------------- webhooks

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly payments: PaymentService) {}

  /**
   * Authenticated by the provider's HMAC signature over the RAW body, not by a user token. 2xx = "received"
   * (including duplicates and ignorable events); a 5xx makes Razorpay retry, which is exactly what we want on a failure.
   */
  @Public()
  @Post('razorpay')
  @HttpCode(200)
  @RateLimit({
    name: 'webhook',
    limit: 600,
    windowSeconds: 60,
    key: 'ip',
    sensitive: false,
  })
  async razorpay(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) return { received: false };
    const result = await this.payments.processWebhook(
      req.rawBody,
      req.headers,
      requestContext(req),
    );
    return { received: true, outcome: result.outcome };
  }
}

// ---------------------------------------------------------------------------------------- admin: orders

const adminListSchema = paginationSchema
  .extend({
    status: z
      .enum([
        'CREATED',
        'INVENTORY_RESERVED',
        'PAYMENT_PENDING',
        'PAYMENT_FAILED',
        'PAID',
        'PROCESSING',
        'SHIPPED',
        'DELIVERED',
        'CANCELLED',
        'REFUND_PENDING',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
        'RETURN_REQUESTED',
        'RETURN_APPROVED',
        'RETURNED',
      ])
      .optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const fulfilmentSchema = z
  .object({
    status: z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED']),
    trackingCarrier: z.string().trim().max(60).optional(),
    trackingNumber: z.string().trim().min(3).max(80).optional(),
  })
  .strict();
const adminReturnsQuerySchema = paginationSchema
  .extend({
    status: z
      .enum(['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED'])
      .optional(),
    orderId: uuid.optional(),
  })
  .strict();
const trackingEventSchema = z
  .object({
    status: z.enum([
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERY_FAILED',
      'DELIVERED',
      'RETURNED_TO_SELLER',
    ]),
    location: z.string().trim().min(2).max(120).optional(),
    note: z.string().trim().min(2).max(200).optional(),
    occurredAt: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  })
  .strict();
const adminCancelSchema = z
  .object({ reason: z.string().trim().min(3).max(200) })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
const receivedSchema = z
  .object({
    refundAmountMinor: z.number().int().min(1).max(2_000_000_000).optional(),
  })
  .strict();

@ApiTags('admin-orders')
@Controller('admin')
@RequireStepUp(1800)
@RateLimit({
  name: 'admin-orders',
  limit: 120,
  windowSeconds: 60,
  key: 'principal',
})
export class AdminOrdersController {
  constructor(
    private readonly orders: OrderService,
    private readonly returns: ReturnService,
    private readonly creditNotes: CreditNoteService,
  ) {}

  @Get('orders')
  @RequirePermissions(Permission.OrdersRead)
  list(@Query({ schema: adminListSchema }) q: z.infer<typeof adminListSchema>) {
    return this.orders.adminList(q);
  }

  @Get('orders/:id')
  @RequirePermissions(Permission.OrdersRead)
  get(@Param('id', { schema: uuid }) id: string) {
    return this.orders.adminGet(id);
  }

  /** The order's tax invoice (paid orders only), as the customer sees it. */
  @Get('orders/:id/invoice')
  @RequirePermissions(Permission.OrdersRead)
  invoice(@Param('id', { schema: uuid }) id: string) {
    return this.orders.adminInvoice(id);
  }

  /** GST credit notes issued against this order (finance documents: payments.read, like the credit-note register). */
  @Get('orders/:id/credit-notes')
  @RequirePermissions(Permission.PaymentsRead)
  orderCreditNotes(@Param('id', { schema: uuid }) id: string) {
    return this.creditNotes.forOrder(id);
  }

  @Get('orders/:id/payments')
  @RequirePermissions(Permission.PaymentsRead)
  payments(@Param('id', { schema: uuid }) id: string) {
    return this.orders.adminPayments(id);
  }

  @Get('orders/:id/tracking')
  @RequirePermissions(Permission.OrdersRead)
  tracking(@Param('id', { schema: uuid }) id: string) {
    return this.orders.trackingForAdmin(id);
  }

  @Post('orders/:id/tracking')
  @HttpCode(200)
  @RequirePermissions(Permission.ShipmentsManage)
  addTracking(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: trackingEventSchema })
    dto: z.infer<typeof trackingEventSchema>,
    @Req() req: Request,
  ) {
    return this.orders.addTrackingEvent(a.userId, id, dto, requestContext(req));
  }

  @Post('orders/:id/fulfilment')
  @HttpCode(200)
  @RequirePermissions(Permission.OrdersUpdate)
  fulfil(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: fulfilmentSchema }) dto: z.infer<typeof fulfilmentSchema>,
    @Req() req: Request,
  ) {
    return this.orders.advance(
      a.userId,
      id,
      dto.status,
      dto,
      requestContext(req),
    );
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(Permission.OrdersUpdate)
  async cancel(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: adminCancelSchema }) dto: z.infer<typeof adminCancelSchema>,
    @Req() req: Request,
  ) {
    await this.orders.cancel(
      id,
      { type: 'ADMIN', id: a.userId },
      dto.reason,
      requestContext(req),
    );
    return this.orders.adminGet(id);
  }

  @Get('returns')
  @RequirePermissions(Permission.OrdersRead)
  listReturns(
    @Query({ schema: adminReturnsQuerySchema })
    q: z.infer<typeof adminReturnsQuerySchema>,
  ) {
    return this.returns.adminList(q);
  }

  @Post('returns/:id/decision')
  @HttpCode(200)
  @RequirePermissions(Permission.OrdersUpdate)
  async decide(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: decisionSchema }) dto: z.infer<typeof decisionSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.returns.decide(
      a.userId,
      id,
      dto.decision,
      dto.note,
      requestContext(req),
    );
    return null;
  }

  @Post('returns/:id/received')
  @HttpCode(200)
  @RequirePermissions(Permission.OrdersUpdate)
  received(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: receivedSchema }) dto: z.infer<typeof receivedSchema>,
    @Req() req: Request,
  ) {
    return this.returns.markReceived(
      a.userId,
      id,
      dto.refundAmountMinor,
      requestContext(req),
    );
  }
}

// --------------------------------------------------------------------------------------- admin: refunds

const refundCreateSchema = z
  .object({
    orderId: z.uuid(),
    amountMinor: z.number().int().min(1).max(2_000_000_000),
    kind: z.enum(['GOODWILL', 'ADMIN']).default('ADMIN'),
    reason: z.string().trim().min(5).max(200),
  })
  .strict();
const rejectSchema = z
  .object({ reason: z.string().trim().min(3).max(200) })
  .strict();

/** An export period: both ends required, `to` after `from`, at most 366 days. */
const periodSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  })
  .strict()
  .refine((v) => v.to > v.from, {
    message: 'to must be after from',
    path: ['to'],
  })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 366 * 86_400_000, {
    message: 'Export at most one year at a time',
    path: ['to'],
  });
/** Most refunds one reconciliation export may hold. */
const REFUND_EXPORT_MAX = 10_000;

@ApiTags('admin-refunds')
@Controller('admin/refunds')
@RequireStepUp(900)
@RateLimit({
  name: 'admin-refunds',
  limit: 60,
  windowSeconds: 60,
  key: 'principal',
})
export class AdminRefundsController {
  constructor(
    private readonly refunds: RefundService,
    private readonly prisma: PrismaService,
    private readonly idem: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Refund reconciliation: every refund requested or processed in [from, to), with the Razorpay ids to match against
   * the settlement report. Audited (finance data export); at most one year and REFUND_EXPORT_MAX rows.
   */
  @Get('export')
  @RequirePermissions(Permission.PaymentsRead)
  @SkipEnvelope()
  @RateLimit({
    name: 'refund-export',
    limit: 20,
    windowSeconds: 3_600,
    key: 'principal',
  })
  async export(
    @CurrentPrincipal() a: AuthPrincipal,
    @Query({ schema: periodSchema }) q: z.infer<typeof periodSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const inRange = { gte: q.from, lt: q.to };
    const rows = await this.prisma.refund.findMany({
      where: { OR: [{ createdAt: inRange }, { processedAt: inRange }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REFUND_EXPORT_MAX + 1,
      select: {
        receipt: true,
        providerRefundId: true,
        kind: true,
        status: true,
        amountMinor: true,
        createdAt: true,
        processedAt: true,
        failureReason: true,
        order: { select: { orderNumber: true } },
        payment: { select: { providerPaymentId: true } },
        creditNote: { select: { creditNoteNumber: true } },
      },
    });
    if (rows.length > REFUND_EXPORT_MAX)
      throw new BadRequestException({
        message: `More than ${REFUND_EXPORT_MAX} refunds in this range: export a shorter period.`,
        code: ErrorCode.ValidationFailed,
      });
    const csv = toCsv(
      REFUND_EXPORT_COLUMNS,
      refundRows(
        rows.map((r) => ({
          ...r,
          orderNumber: r.order.orderNumber,
          providerPaymentId: r.payment.providerPaymentId,
          creditNoteNumber: r.creditNote?.creditNoteNumber ?? null,
        })),
      ),
    );
    await this.audit.record({
      action: AuditAction.FinanceExported,
      outcome: 'SUCCESS',
      actorId: a.userId,
      ...requestContext(req),
      resourceType: 'refund_reconciliation',
      metadata: {
        from: q.from.toISOString(),
        to: q.to.toISOString(),
        refunds: rows.length,
      },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="refunds-${indianIsoDate(q.from)}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  @Get()
  @RequirePermissions(Permission.PaymentsRead)
  async list(
    @Query({
      schema: paginationSchema
        .extend({
          status: z
            .enum([
              'PENDING_APPROVAL',
              'APPROVED',
              'PROCESSING',
              'PROCESSED',
              'FAILED',
              'REJECTED',
            ])
            .optional(),
        })
        .strict(),
    })
    q: PaginationQuery,
  ) {
    const where = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          orderId: true,
          kind: true,
          amountMinor: true,
          status: true,
          reason: true,
          requestedById: true,
          approvedById: true,
          createdAt: true,
          processedAt: true,
          failureReason: true,
          order: { select: { orderNumber: true } },
          creditNote: { select: { id: true, creditNoteNumber: true } },
          retryOfId: true,
          retriedBy: { select: { id: true, status: true } },
        },
      }),
      this.prisma.refund.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  /** Raises a refund REQUEST. It moves no money until a different person approves it. */
  @Post()
  @RequirePermissions(Permission.RefundsCreate)
  async create(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: refundCreateSchema })
    dto: z.infer<typeof refundCreateSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = requestContext(req);
    const idemKey = assertIdempotencyKey(key);
    const r = await this.idem.run(
      { scope: 'refund.create', actorId: a.userId, key: idemKey, request: dto },
      async () => {
        const payment = await this.prisma.payment.findFirst({
          where: {
            orderId: dto.orderId,
            status: {
              in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'],
            },
          },
        });
        if (!payment)
          throw new NotFoundException('No captured payment for this order');
        const refundKey = `admin:${a.userId}:${idemKey}`;
        // audited IN the refund's transaction: a request is recorded exactly when it is created (a failure afterwards
        // cannot leave it unaudited; the same key again finds the existing refund and records nothing)
        const refund = await this.prisma.$transaction(async (tx) => {
          const existed = await tx.refund.findUnique({
            where: { idempotencyKey: refundKey },
            select: { id: true },
          });
          const r = await this.refunds.requestInTx(tx, {
            paymentId: payment.id,
            kind: dto.kind,
            amountMinor: dto.amountMinor,
            reason: dto.reason,
            requestedById: a.userId,
            autoApprove: false,
            idempotencyKey: refundKey,
          });
          if (!existed)
            await this.audit.recordInTx(tx, {
              action: AuditAction.RefundRequested,
              outcome: 'SUCCESS',
              actorId: a.userId,
              ...ctx,
              resourceType: 'refund',
              resourceId: r.id,
              metadata: {
                orderId: dto.orderId,
                kind: dto.kind,
                amountMinor: r.amountMinor,
              },
            });
          return r;
        });
        return {
          status: 201,
          body: {
            id: refund.id,
            status: refund.status,
            amountMinor: refund.amountMinor,
          },
        };
      },
    );
    setIdempotent(res, r.replayed);
    res.status(r.status);
    return r.body;
  }

  /** Retries a FAILED refund as a NEW request (a different person must approve it). Needs an Idempotency-Key. */
  @Post(':id/retry')
  @RequirePermissions(Permission.RefundsCreate)
  async retry(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idemKey = assertIdempotencyKey(key);
    const r = await this.idem.run(
      {
        scope: 'refund.retry',
        actorId: a.userId,
        key: idemKey,
        request: { id },
      },
      async () => {
        const retry = await this.refunds.retryFailed(
          a,
          id,
          requestContext(req),
        );
        return {
          status: 201,
          body: {
            id: retry.id,
            status: retry.status,
            amountMinor: retry.amountMinor,
            retryOfId: id,
          },
        };
      },
    );
    setIdempotent(res, r.replayed);
    res.status(r.status);
    return r.body;
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions(Permission.RefundsApprove)
  async approve(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Req() req: Request,
  ) {
    const r = await this.refunds.approve(a, id, requestContext(req));
    return { id: r.id, status: r.status, amountMinor: r.amountMinor };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions(Permission.RefundsApprove)
  async reject(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: rejectSchema }) dto: z.infer<typeof rejectSchema>,
    @Req() req: Request,
  ) {
    const r = await this.refunds.reject(a, id, dto.reason, requestContext(req));
    return { id: r.id, status: r.status };
  }
}

type PaginationQuery = z.infer<typeof paginationSchema> & {
  status?:
    | 'PENDING_APPROVAL'
    | 'APPROVED'
    | 'PROCESSING'
    | 'PROCESSED'
    | 'FAILED'
    | 'REJECTED'
    | undefined;
};

// ---------------------------------------------------------------------------------- admin: credit notes

const creditNoteListSchema = paginationSchema
  .extend({
    from: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  })
  .strict();

/** Finance view of the GST credit notes (for filing and for reprints). Read-only: notes are issued automatically. */
@ApiTags('admin-credit-notes')
@Controller('admin/credit-notes')
@RequireStepUp(1800)
@RequirePermissions(Permission.PaymentsRead)
@RateLimit({
  name: 'admin-credit-notes',
  limit: 120,
  windowSeconds: 60,
  key: 'principal',
})
export class AdminCreditNotesController {
  constructor(
    private readonly creditNotes: CreditNoteService,
    private readonly audit: AuditService,
  ) {}

  /** The credit-note register for a filing period as CSV (GSTR-1 layout). Audited: it is a finance data export. */
  @Get('export')
  @SkipEnvelope()
  @RateLimit({
    name: 'credit-note-export',
    limit: 20,
    windowSeconds: 3_600,
    key: 'principal',
  })
  async export(
    @CurrentPrincipal() a: AuthPrincipal,
    @Query({ schema: periodSchema })
    q: z.infer<typeof periodSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { csv, notes } = await this.creditNotes.exportCsv(q.from, q.to);
    await this.audit.record({
      action: AuditAction.FinanceExported,
      outcome: 'SUCCESS',
      actorId: a.userId,
      ...requestContext(req),
      resourceType: 'credit_note_register',
      metadata: {
        from: q.from.toISOString(),
        to: q.to.toISOString(),
        notes,
      },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="credit-notes-${indianIsoDate(q.from)}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  @Get()
  list(
    @Query({ schema: creditNoteListSchema })
    q: z.infer<typeof creditNoteListSchema>,
  ) {
    return this.creditNotes.adminList(q);
  }

  @Get(':id')
  get(@Param('id', { schema: uuid }) id: string) {
    return this.creditNotes.adminGet(id);
  }
}
