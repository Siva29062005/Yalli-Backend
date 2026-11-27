import { REFUND_EXPORT_COLUMNS, refundRows } from './refund-export.js';

describe('refund reconciliation rows', () => {
  it('one row per refund with the provider ids, exact rupees and India dates; blanks for what is not there yet', () => {
    const [done, pending] = refundRows([
      {
        receipt: 'rf_01',
        providerRefundId: 'rfnd_123',
        providerPaymentId: 'pay_456',
        orderNumber: 'YL26-000001',
        kind: 'GOODWILL',
        status: 'PROCESSED',
        amountMinor: 25_050,
        createdAt: new Date('2026-11-20T19:00:00Z'),
        processedAt: new Date('2026-11-21T04:00:00Z'),
        creditNoteNumber: 'CN/2627/000003',
        failureReason: null,
      },
      {
        receipt: 'rf_02',
        providerRefundId: null,
        providerPaymentId: null,
        orderNumber: 'YL26-000002',
        kind: 'ADMIN',
        status: 'PENDING_APPROVAL',
        amountMinor: 100,
        createdAt: new Date('2026-11-21T04:00:00Z'),
        processedAt: null,
        creditNoteNumber: null,
        failureReason: null,
      },
    ]);
    expect(done).toEqual([
      'rf_01',
      'rfnd_123',
      'pay_456',
      'YL26-000001',
      'GOODWILL',
      'PROCESSED',
      '250.50',
      '21-11-2026',
      '21-11-2026',
      'CN/2627/000003',
      '',
    ]);
    expect(pending!.slice(1, 3)).toEqual(['', '']);
    expect(pending![8]).toBe('');
    expect(done!.length).toBe(REFUND_EXPORT_COLUMNS.length);
  });
});
