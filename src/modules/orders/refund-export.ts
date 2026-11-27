import { indianDate, rupees } from './gstr1-export.js';

/**
 * Refund reconciliation sheet (pure, unit-tested): our side of every refund in a period, with the Razorpay ids that
 * finance matches against the settlement report downloaded from the Razorpay dashboard (refunds are netted from
 * settlements there). Amounts in rupees from paise; dates are India calendar days.
 */
export const REFUND_EXPORT_COLUMNS = [
  'Refund reference',
  'Razorpay refund id',
  'Razorpay payment id',
  'Order number',
  'Kind',
  'Status',
  'Amount',
  'Requested on',
  'Processed on',
  'Credit note',
  'Failure reason',
] as const;

export interface RefundForExport {
  receipt: string;
  providerRefundId: string | null;
  providerPaymentId: string | null;
  orderNumber: string;
  kind: string;
  status: string;
  amountMinor: number;
  createdAt: Date;
  processedAt: Date | null;
  creditNoteNumber: string | null;
  failureReason: string | null;
}

export function refundRows(refunds: readonly RefundForExport[]): string[][] {
  return refunds.map((r) => [
    r.receipt,
    r.providerRefundId ?? '',
    r.providerPaymentId ?? '',
    r.orderNumber,
    r.kind,
    r.status,
    rupees(r.amountMinor),
    indianDate(r.createdAt),
    r.processedAt ? indianDate(r.processedAt) : '',
    r.creditNoteNumber ?? '',
    r.failureReason ?? '',
  ]);
}
