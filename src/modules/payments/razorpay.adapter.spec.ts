import { ConfigService } from '@nestjs/config';
import {
  FakeRazorpayApi,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
  TEST_WEBHOOK_SECRET,
} from '../../../test/support/fake-razorpay.js';
import { PaymentProviderError } from './payment-provider.js';
import { RazorpayAdapter } from './razorpay.adapter.js';

const make = (env: Record<string, string | undefined> = {}) => {
  const api = new FakeRazorpayApi();
  const config = new ConfigService({
    RAZORPAY_KEY_ID: TEST_KEY_ID,
    RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ...env,
  });
  return { api, adapter: new RazorpayAdapter(config as never, api) };
};

describe('webhook signature (HMAC-SHA256 over the RAW body)', () => {
  const { api, adapter } = make();
  const p = api.pay(
    (api.orders.set('order_x', {
      id: 'order_x',
      amount: 59_000,
      currency: 'INR',
      receipt: 'r',
      status: 'created',
    }),
    'order_x'),
    'captured',
  );
  const { raw, headers } = api.paymentWebhook('payment.captured', p);
  const sig = headers['x-razorpay-signature'];

  it('accepts the genuine signature', () => {
    expect(adapter.verifyWebhook(Buffer.from(raw), sig)).toBe(true);
  });
  it('matches the published algorithm (independent computation)', async () => {
    const { createHmac } = await import('node:crypto');
    expect(sig).toBe(
      createHmac('sha256', TEST_WEBHOOK_SECRET).update(raw).digest('hex'),
    );
  });
  it('rejects a body that was altered by even one byte (e.g. amount tampering)', () => {
    expect(
      adapter.verifyWebhook(Buffer.from(raw.replace('59000', '1')), sig),
    ).toBe(false);
    expect(adapter.verifyWebhook(Buffer.from(`${raw} `), sig)).toBe(false);
  });
  it('rejects JSON that is equivalent but not byte-identical (the signature covers raw bytes, not parsed data)', () => {
    expect(
      adapter.verifyWebhook(
        Buffer.from(JSON.stringify(JSON.parse(raw), null, 2)),
        sig,
      ),
    ).toBe(false);
  });
  it.each([
    [undefined],
    [''],
    ['not-hex'],
    ['0'.repeat(64)],
    ['A'.repeat(63)],
    [sig.slice(0, 63)],
    [`${sig}00`],
  ])('rejects missing/malformed/wrong signature %j', (bad) => {
    expect(
      adapter.verifyWebhook(Buffer.from(raw), bad as string | undefined),
    ).toBe(false);
  });
  it('rejects a signature made with a different secret', () => {
    const forged = api.paymentWebhook('payment.captured', p, {
      secret: 'attacker_secret_0123456789abcdef',
    });
    expect(
      adapter.verifyWebhook(
        Buffer.from(forged.raw),
        forged.headers['x-razorpay-signature'],
      ),
    ).toBe(false);
  });
  it('fails closed when the webhook secret is not configured', () => {
    expect(
      make({ RAZORPAY_WEBHOOK_SECRET: undefined }).adapter.verifyWebhook(
        Buffer.from(raw),
        sig,
      ),
    ).toBe(false);
  });
});

describe('checkout signature', () => {
  const { adapter } = make();
  it('verifies HMAC(order_id|payment_id, key_secret)', () => {
    const api = new FakeRazorpayApi();
    api.orders.set('order_1', {
      id: 'order_1',
      amount: 100,
      currency: 'INR',
      receipt: 'r',
      status: 'created',
    });
    const cb = api.checkoutCallback(api.pay('order_1', 'captured'));
    expect(
      adapter.verifyCheckoutSignature({
        providerOrderId: cb.razorpay_order_id,
        providerPaymentId: cb.razorpay_payment_id,
        signature: cb.razorpay_signature,
      }),
    ).toBe(true);
  });
  it('rejects a signature for a different payment, or one made without the key secret', () => {
    const ok = FakeRazorpayApi.sign(TEST_KEY_SECRET, 'order_1|pay_1');
    expect(
      adapter.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_2',
        signature: ok,
      }),
    ).toBe(false);
    expect(
      adapter.verifyCheckoutSignature({
        providerOrderId: 'order_2',
        providerPaymentId: 'pay_1',
        signature: ok,
      }),
    ).toBe(false);
    expect(
      adapter.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: FakeRazorpayApi.sign(
          'wrong_secret_wrong_secret_xx',
          'order_1|pay_1',
        ),
      }),
    ).toBe(false);
    expect(
      adapter.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: 'zz',
      }),
    ).toBe(false);
  });
});

describe('webhook parsing and status mapping', () => {
  const { api, adapter } = make();
  api.orders.set('order_p', {
    id: 'order_p',
    amount: 25_000,
    currency: 'INR',
    receipt: 'r',
    status: 'created',
  });

  it('maps payments to the internal model and keeps only the fields we need', () => {
    const p = api.pay('order_p', 'failed');
    const { raw, headers } = api.paymentWebhook('payment.failed', p, {
      eventId: 'evt_abc123456',
    });
    const ev = adapter.parseWebhook(Buffer.from(raw), headers)!;
    expect(ev).toMatchObject({
      id: 'evt_abc123456',
      type: 'payment.failed',
      payment: {
        id: p.id,
        orderId: 'order_p',
        amountMinor: 25_000,
        currency: 'INR',
        status: 'failed',
        errorCode: 'BAD_REQUEST_ERROR',
      },
    });
    // customer PII from the provider payload is not carried into our domain object
    expect(JSON.stringify(ev)).not.toMatch(
      /customer@example\.com|4242|\+9198765/,
    );
  });
  it('treats unknown provider statuses as "created" (never infers captured money)', () => {
    const p = { ...api.pay('order_p', 'authorized'), status: 'some_new_state' };
    const { raw, headers } = api.paymentWebhook('payment.authorized', p);
    expect(
      adapter.parseWebhook(Buffer.from(raw), headers)!.payment!.status,
    ).toBe('created');
  });
  it('rejects deliveries without a usable event id or timestamp, and non-JSON', () => {
    const p = api.pay('order_p', 'captured');
    const { raw, headers } = api.paymentWebhook('payment.captured', p);
    expect(
      adapter.parseWebhook(Buffer.from(raw), {
        ...headers,
        'x-razorpay-event-id': undefined,
      }),
    ).toBeNull();
    expect(
      adapter.parseWebhook(Buffer.from(raw), {
        ...headers,
        'x-razorpay-event-id': 'bad id!',
      }),
    ).toBeNull();
    expect(
      adapter.parseWebhook(
        Buffer.from('{"event":"payment.captured"}'),
        headers,
      ),
    ).toBeNull();
    expect(adapter.parseWebhook(Buffer.from('not json'), headers)).toBeNull();
  });
  it('parses refund events', () => {
    const r = {
      id: 'rfnd_1',
      payment_id: 'pay_1',
      amount: 500,
      status: 'processed',
      receipt: 'RF-1',
    };
    const { raw, headers } = api.refundWebhook('refund.processed', r);
    expect(adapter.parseWebhook(Buffer.from(raw), headers)).toMatchObject({
      type: 'refund.processed',
      refund: {
        id: 'rfnd_1',
        amountMinor: 500,
        status: 'processed',
        receipt: 'RF-1',
      },
    });
  });
});

describe('API calls', () => {
  it('creates orders in integer paise with our receipt, and surfaces definitive vs unknown failures distinctly', async () => {
    const { api, adapter } = make();
    const o = await adapter.createOrder({
      amountMinor: 118_000,
      currency: 'INR',
      receipt: 'YL26-1001',
    });
    expect(o).toEqual({
      providerOrderId: expect.stringMatching(/^order_/),
      amountMinor: 118_000,
      currency: 'INR',
    });
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/orders',
      body: { amount: 118_000, currency: 'INR', receipt: 'YL26-1001' },
    });

    api.failNext.push(
      { match: '/refund', mode: 'reject' },
      { match: '/refund', mode: 'timeout-no-effect' },
    );
    const p = api.pay(o.providerOrderId, 'captured');
    await expect(
      adapter.createRefund({
        providerPaymentId: p.id,
        amountMinor: 1,
        receipt: 'r1',
      }),
    ).rejects.toMatchObject({ definitive: true });
    await expect(
      adapter.createRefund({
        providerPaymentId: p.id,
        amountMinor: 1,
        receipt: 'r2',
      }),
    ).rejects.toMatchObject({ definitive: false });
  });
  it('refuses to operate unconfigured (and says so without leaking details)', async () => {
    const { adapter } = make({
      RAZORPAY_KEY_ID: undefined,
      RAZORPAY_KEY_SECRET: undefined,
    });
    expect(() => adapter.publicConfig()).toThrow(PaymentProviderError);
    expect(() =>
      adapter.verifyCheckoutSignature({
        providerOrderId: 'o',
        providerPaymentId: 'p',
        signature: 'a'.repeat(64),
      }),
    ).toThrow(PaymentProviderError);
  });
});
