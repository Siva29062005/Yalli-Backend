import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { takeSerial } from './document-counter.js';
import {
  paginated,
  type PaginationInput,
} from '../../common/http/pagination.js';
import { sameStateSupply } from './gst.js';
import {
  GSTR1_CREDIT_NOTE_COLUMNS,
  creditNoteRows,
  toCsv,
} from './gstr1-export.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';
import {
  creditNoteLines,
  creditNoteNumber,
  financialYear,
  type Credited,
} from './tax-documents.js';

type Tx = Prisma.TransactionClient;

/** Most credit notes one CSV export may hold. */
const EXPORT_MAX = 5_000;

const withLines = {
  lines: { orderBy: { position: 'asc' as const } },
  order: { select: { orderNumber: true, shipName: true, contactEmail: true } },
} satisfies Prisma.CreditNoteInclude;
type CreditNoteRow = Prisma.CreditNoteGetPayload<{ include: typeof withLines }>;

/**
 * GST credit notes (CGST Act s.34): one per PROCESSED refund of an order that had an invoice, apportioned over what that
 * invoice still has to credit (see tax-documents.ts). Numbers are consecutive per Indian financial year and taken from
 * a counter row locked in the same transaction as the note, so the series has no gaps. Notes are immutable (trigger).
 */
@Injectable()
export class CreditNoteService {
  private readonly logger = new Logger(CreditNoteService.name);
  private readonly sellerName: string;
  private readonly sellerState: string;
  private readonly sellerGstin: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly outbox: OutboxService,
  ) {
    this.sellerName = config.get('SELLER_LEGAL_NAME', { infer: true });
    this.sellerState = config.get('SELLER_STATE', { infer: true });
    this.sellerGstin = config.get('SELLER_GSTIN', { infer: true });
  }

  /** Issues the credit note for a refund inside the caller's transaction. Idempotent; null when none is due. */
  async issueForRefundInTx(
    tx: Tx,
    refundId: string,
    now: Date = new Date(),
  ): Promise<{ id: string; creditNoteNumber: string } | null> {
    const head = await tx.refund.findUnique({
      where: { id: refundId },
      select: { orderId: true },
    });
    if (!head) return null;
    // Lock order: ORDER row first (same as every money flow), so two notes for one order are serialised.
    const order = await this.lifecycle.lock(tx, head.orderId);
    const refund = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { creditNote: { select: { id: true, creditNoteNumber: true } } },
    });
    if (refund.creditNote) return refund.creditNote;
    if (refund.status !== 'PROCESSED') return null;
    if (!order.paidAt) return null; // never invoiced (e.g. a late payment on a cancelled order): nothing to adjust

    const [items, earlier, returned] = await Promise.all([
      tx.orderItem.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      }),
      tx.creditNoteLine.findMany({
        where: { creditNote: { orderId: order.id } },
        select: {
          orderItemId: true,
          kind: true,
          totalMinor: true,
          cgstMinor: true,
          sgstMinor: true,
          igstMinor: true,
        },
      }),
      refund.returnRequestId
        ? tx.returnRequest.findUnique({
            where: { id: refund.returnRequestId },
            select: { orderItemId: true },
          })
        : null,
    ]);
    const alreadyCredited: Credited[] = earlier.map((l) => ({
      orderItemId: l.orderItemId,
      kind: l.kind as Credited['kind'],
      totalMinor: l.totalMinor,
      taxMinor: l.cgstMinor + l.sgstMinor + l.igstMinor,
    }));
    const same = sameStateSupply(order.shipState, this.sellerState);
    const lines = creditNoteLines({
      items,
      orderShippingMinor: order.shippingMinor,
      amountMinor: refund.amountMinor,
      sameState: same,
      returnedItemId: returned?.orderItemId ?? null,
      alreadyCredited,
    });

    const fy = financialYear(now);
    const serial = await takeSerial(tx, `credit_note:${fy.label}`);

    const sum = (
      k:
        | 'taxableValueMinor'
        | 'cgstMinor'
        | 'sgstMinor'
        | 'igstMinor'
        | 'lineTotalMinor',
    ) => lines.reduce((a, l) => a + l[k], 0);
    const note = await tx.creditNote.create({
      data: {
        creditNoteNumber: creditNoteNumber(fy.short, serial),
        financialYear: fy.label,
        refundId: refund.id,
        orderId: order.id,
        invoiceNumber: order.invoiceNumber!, // set with paidAt (orders_invoice_paid_chk)
        reason: refund.reason,
        supply: same ? 'INTRA_STATE' : 'INTER_STATE',
        placeOfSupply: order.shipState,
        taxableValueMinor: sum('taxableValueMinor'),
        cgstMinor: sum('cgstMinor'),
        sgstMinor: sum('sgstMinor'),
        igstMinor: sum('igstMinor'),
        totalMinor: sum('lineTotalMinor'),
        issuedAt: now,
        lines: {
          create: lines.map((l, i) => ({
            position: i + 1,
            kind: l.kind,
            orderItemId: l.orderItemId,
            description: l.description.slice(0, 250),
            hsnCode: l.hsn,
            gstRateBps: l.gstRateBps,
            taxableValueMinor: l.taxableValueMinor,
            cgstMinor: l.cgstMinor,
            sgstMinor: l.sgstMinor,
            igstMinor: l.igstMinor,
            totalMinor: l.lineTotalMinor,
          })),
        },
      },
      select: { id: true, creditNoteNumber: true },
    });
    // Same transaction as the note: the refund email (with the note attached) goes out exactly when the note exists.
    await this.outbox.add(tx, {
      aggregateType: 'credit_note',
      aggregateId: note.id,
      eventType: 'credit_note.issued',
      payload: {
        creditNoteId: note.id,
        refundId: refund.id,
        orderId: refund.orderId,
        amountMinor: refund.amountMinor,
      },
    });
    this.logger.log(
      `credit note ${note.creditNoteNumber} issued for refund ${refund.id}`,
    );
    return note;
  }

  /** The printable document, read on the caller's transaction (consumers: one connection at a time). */
  async documentInTx(tx: Prisma.TransactionClient, id: string) {
    const note = await tx.creditNote.findUnique({
      where: { id },
      include: withLines,
    });
    return note ? this.document(note) : null;
  }

  /** The customer's own credit notes for an order (a foreign order is a 404, as everywhere). */
  async forCustomer(userId: string, orderId: string) {
    const own = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true },
    });
    if (!own) throw new NotFoundException('Order not found');
    const notes = await this.prisma.creditNote.findMany({
      where: { orderId },
      orderBy: { issuedAt: 'asc' },
      include: withLines,
    });
    return notes.map((n) => this.document(n));
  }

  /** Staff view of one order's credit notes (oldest first). An unknown order is a 404. */
  async forOrder(orderId: string) {
    const exists = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Order not found');
    const notes = await this.prisma.creditNote.findMany({
      where: { orderId },
      orderBy: { issuedAt: 'asc' },
      include: withLines,
    });
    return notes.map((n) => this.document(n));
  }

  /**
   * Every credit note issued in [from, to) as a GSTR-1-style CSV (`gstr1-export.ts`). Capped: a range with more than
   * EXPORT_MAX notes must be split (a filing period is a month or a quarter).
   */
  async exportCsv(
    from: Date,
    to: Date,
  ): Promise<{ csv: string; notes: number }> {
    const notes = await this.prisma.creditNote.findMany({
      where: { issuedAt: { gte: from, lt: to } },
      orderBy: [{ issuedAt: 'asc' }, { creditNoteNumber: 'asc' }],
      take: EXPORT_MAX + 1,
      select: {
        creditNoteNumber: true,
        issuedAt: true,
        invoiceNumber: true,
        placeOfSupply: true,
        supply: true,
        reason: true,
        totalMinor: true,
        order: { select: { orderNumber: true, paidAt: true } },
        lines: {
          select: {
            gstRateBps: true,
            taxableValueMinor: true,
            cgstMinor: true,
            sgstMinor: true,
            igstMinor: true,
          },
        },
      },
    });
    if (notes.length > EXPORT_MAX)
      throw new BadRequestException({
        message: `More than ${EXPORT_MAX} credit notes in this range: export a shorter period.`,
        code: ErrorCode.ValidationFailed,
      });
    const rows = creditNoteRows(
      notes.map((n) => ({
        ...n,
        orderNumber: n.order.orderNumber,
        invoiceDate: n.order.paidAt, // the invoice is dated when the order was paid
      })),
    );
    return { csv: toCsv(GSTR1_CREDIT_NOTE_COLUMNS, rows), notes: notes.length };
  }

  async adminGet(id: string) {
    const note = await this.prisma.creditNote.findUnique({
      where: { id },
      include: withLines,
    });
    if (!note) throw new NotFoundException('Credit note not found');
    return this.document(note);
  }

  async adminList(
    q: PaginationInput & { from?: Date | undefined; to?: Date | undefined },
  ) {
    const where: Prisma.CreditNoteWhereInput =
      q.from || q.to
        ? {
            issuedAt: {
              ...(q.from ? { gte: q.from } : {}),
              ...(q.to ? { lt: q.to } : {}),
            },
          }
        : {};
    const [rows, total] = await Promise.all([
      this.prisma.creditNote.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          creditNoteNumber: true,
          issuedAt: true,
          invoiceNumber: true,
          refundId: true,
          totalMinor: true,
          taxableValueMinor: true,
          cgstMinor: true,
          sgstMinor: true,
          igstMinor: true,
          order: { select: { orderNumber: true } },
        },
      }),
      this.prisma.creditNote.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  private document(n: CreditNoteRow) {
    return {
      id: n.id,
      creditNoteNumber: n.creditNoteNumber,
      issuedAt: n.issuedAt,
      financialYear: n.financialYear,
      invoiceNumber: n.invoiceNumber,
      orderNumber: n.order.orderNumber,
      reason: n.reason,
      taxDocument: this.sellerGstin !== undefined, // a GST credit note only once the seller GSTIN is configured
      seller: {
        name: this.sellerName,
        state: this.sellerState,
        gstin: this.sellerGstin ?? null,
      },
      buyer: { name: n.order.shipName, email: n.order.contactEmail },
      placeOfSupply: n.placeOfSupply,
      supply: n.supply as 'INTRA_STATE' | 'INTER_STATE',
      currency: 'INR' as const,
      lines: n.lines.map((l) => ({
        kind: l.kind as 'GOODS' | 'DELIVERY',
        description: l.description,
        hsn: l.hsnCode,
        gstRateBps: l.gstRateBps,
        taxableValueMinor: l.taxableValueMinor,
        cgstMinor: l.cgstMinor,
        sgstMinor: l.sgstMinor,
        igstMinor: l.igstMinor,
        totalMinor: l.totalMinor,
      })),
      totals: {
        taxableValueMinor: n.taxableValueMinor,
        cgstMinor: n.cgstMinor,
        sgstMinor: n.sgstMinor,
        igstMinor: n.igstMinor,
        totalMinor: n.totalMinor,
      },
    };
  }
}
