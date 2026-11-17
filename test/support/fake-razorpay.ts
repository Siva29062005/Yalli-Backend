import { createHmac, randomBytes } from 'node:crypto';
import { RazorpayHttp } from '../../src/modules/payments/razorpay.adapter.js';
import { PaymentProviderError } from '../../src/modules/payments/payment-provider.js';

export const TEST_KEY_ID = 'rzp_test_AbCdEf1234';
export const TEST_KEY_SECRET = 'test_key_secret_0123456789abcdef';
export const TEST_WEBHOOK_SECRET = 'test_webhook_secret_0123456789ab';

export interface Order {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: 'created' | 'paid';
}
export interface Pay {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  method: string;
  error_code: string | null;
  error_description: string | null;
  amount_refunded: number;
  email: string;
  contact: string;
  card: { last4: string };
}
export interface Ref {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
  receipt: string;
}

/**
 * An in-process stand-in for the Razorpay REST API (orders, payments, capture, refunds) with the same response shapes.
 * It is the ONLY fake in the payment tests: the real RazorpayAdapter, services, webhook endpoint and database all run.
 * Failure injection lets tests simulate timeouts and definitive rejections.
 */
export class FakeRazorpayApi extends RazorpayHttp {
  orders = new Map<string, Order>();
  payments = new Map<string, Pay>();
  refunds = new Map<string, Ref>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  /** Next N calls to this path-prefix fail: 'timeout' (outcome unknown, but the action IS performed) or 'reject' (definitive, not performed). */
  failNext: {
    match: string;
    mode: 'timeout-after-effect' | 'timeout-no-effect' | 'reject';
  }[] = [];
  refundStatus: 'processed' | 'pending' = 'processed';

  private id(prefix: string) {
    return `${prefix}_${randomBytes(7).toString('hex')}`;
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    this.calls.push({ method, path, body });
    const idx = this.failNext.findIndex((f) => path.includes(f.match));
    const failure = idx >= 0 ? this.failNext.splice(idx, 1)[0]! : null;
    if (failure?.mode === 'reject')
      throw new PaymentProviderError(
        'The amount exceeds the refundable amount',
        true,
        'BAD_REQUEST_ERROR',
      );
    if (failure?.mode === 'timeout-no-effect')
      throw new PaymentProviderError(
        'Payment provider unreachable',
        false,
        'NETWORK',
      );
    const result = this.handle(
      method,
      path,
      body as Record<string, unknown> | undefined,
    );
    if (failure?.mode === 'timeout-after-effect')
      throw new PaymentProviderError(
        'Payment provider unreachable',
        false,
        'NETWORK',
      );
    return result;
  }

  private handle(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): unknown {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/orders') {
      const o: Order = {
        id: this.id('order'),
        amount: body!['amount'] as number,
        currency: body!['currency'] as string,
        receipt: body!['receipt'] as string,
        status: 'created',
      };
      this.orders.set(o.id, o);
      return o;
    }
    if (method === 'GET' && (m = path.match(/^\/payments\/([^/]+)$/)))
      return this.mustPay(m[1]!);
    if (method === 'GET' && (m = path.match(/^\/orders\/([^/]+)\/payments$/)))
      return {
        items: [...this.payments.values()].filter((p) => p.order_id === m![1]),
      };
    if (
      method === 'POST' &&
      (m = path.match(/^\/payments\/([^/]+)\/capture$/))
    ) {
      const p = this.mustPay(m[1]!);
      if (p.status !== 'authorized')
        throw new PaymentProviderError(
          'Payment is not authorized',
          true,
          'BAD_REQUEST_ERROR',
        );
      if (body!['amount'] !== p.amount)
        throw new PaymentProviderError(
          'Capture amount must equal the authorized amount',
          true,
          'BAD_REQUEST_ERROR',
        );
      p.status = 'captured';
      return p;
    }
    if (
      method === 'POST' &&
      (m = path.match(/^\/payments\/([^/]+)\/refund$/))
    ) {
      const p = this.mustPay(m[1]!);
      const amount = body!['amount'] as number;
      if (p.status !== 'captured' || p.amount_refunded + amount > p.amount)
        throw new PaymentProviderError(
          'The amount exceeds the refundable amount',
          true,
          'BAD_REQUEST_ERROR',
        );
      p.amount_refunded += amount;
      const r: Ref = {
        id: this.id('rfnd'),
        payment_id: p.id,
        amount,
        status: this.refundStatus,
        receipt: body!['receipt'] as string,
      };
      this.refunds.set(r.id, r);
      return r;
    }
    if (method === 'GET' && (m = path.match(/^\/payments\/([^/]+)\/refunds$/)))
      return {
        items: [...this.refunds.values()].filter((r) => r.payment_id === m![1]),
      };
    throw new PaymentProviderError(
      `Unhandled fake route ${method} ${path}`,
      true,
      'NOT_FOUND',
    );
  }

  private mustPay(id: string): Pay {
    const p = this.payments.get(id);
    if (!p)
      throw new PaymentProviderError(
        'The id provided does not exist',
        true,
        'BAD_REQUEST_ERROR',
      );
    return p;
  }

  // ------------------------------------------------------------------ "the customer's browser / bank" side

  /** The customer pays on Razorpay's hosted checkout. Returns the payment as the provider now sees it. */
  pay(
    orderId: string,
    outcome: 'captured' | 'authorized' | 'failed',
    over: Partial<Pay> = {},
  ): Pay {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown fake order ${orderId}`);
    const p: Pay = {
      id: this.id('pay'),
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: outcome,
      method: 'upi',
      error_code: outcome === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_description:
        outcome === 'failed' ? 'Payment failed at the bank' : null,
      amount_refunded: 0,
      email: 'customer@example.com',
      contact: '+919876543210',
      card: { last4: '4242' },
      ...over,
    };
    this.payments.set(p.id, p);
    if (outcome === 'captured') order.status = 'paid';
    return p;
  }

  // -------------------------------------------------------------------- what Razorpay would POST to us

  static sign(secret: string, raw: string | Buffer): string {
    return createHmac('sha256', secret).update(raw).digest('hex');
  }

  /** A signed webhook delivery for a payment event. `eventId` is the de-duplication key (same id = a redelivery). */
  paymentWebhook(
    event: 'payment.authorized' | 'payment.captured' | 'payment.failed',
    p: Pay,
    opts: { eventId?: string; createdAt?: number; secret?: string } = {},
  ) {
    const raw = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event,
      contains: ['payment'],
      payload: { payment: { entity: p } },
      created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    });
    return { raw, headers: this.headers(raw, opts) };
  }

  refundWebhook(
    event: 'refund.processed' | 'refund.failed' | 'refund.created',
    r: Ref,
    opts: { eventId?: string; createdAt?: number; secret?: string } = {},
  ) {
    // Like the real service, a refund event carries BOTH the payment and the refund entity.
    const payment = this.payments.get(r.payment_id);
    const raw = JSON.stringify({
      entity: 'event',
      event,
      contains: payment ? ['refund', 'payment'] : ['refund'],
      payload: {
        ...(payment ? { payment: { entity: payment } } : {}),
        refund: { entity: r },
      },
      created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    });
    return { raw, headers: this.headers(raw, opts) };
  }

  private headers(raw: string, opts: { eventId?: string; secret?: string }) {
    return {
      'content-type': 'application/json',
      'x-razorpay-signature': FakeRazorpayApi.sign(
        opts.secret ?? TEST_WEBHOOK_SECRET,
        raw,
      ),
      'x-razorpay-event-id':
        opts.eventId ?? `evt_${randomBytes(8).toString('hex')}`,
    };
  }

  /** What Razorpay's checkout.js hands back to the browser's success handler. */
  checkoutCallback(p: Pay, secret = TEST_KEY_SECRET) {
    return {
      razorpay_order_id: p.order_id,
      razorpay_payment_id: p.id,
      razorpay_signature: FakeRazorpayApi.sign(secret, `${p.order_id}|${p.id}`),
    };
  }
}
