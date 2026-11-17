import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env.js';
import {
  PaymentProvider,
  PaymentProviderError,
  type ProviderOrder,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type ProviderRefund,
  type ProviderRefundStatus,
  type ProviderWebhookEvent,
} from './payment-provider.js';

/** Transport seam: production uses fetch; tests plug in an in-process Razorpay simulator. */
export abstract class RazorpayHttp {
  abstract request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown>;
}

@Injectable()
export class FetchRazorpayHttp extends RazorpayHttp {
  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const keyId = this.config.get('RAZORPAY_KEY_ID', { infer: true });
    const secret = this.config.get('RAZORPAY_KEY_SECRET', { infer: true });
    if (!keyId || !secret)
      throw new PaymentProviderError(
        'Payments are not configured',
        true,
        'NOT_CONFIGURED',
      );
    let res: Response;
    try {
      res = await fetch(`https://api.razorpay.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PaymentProviderError(
        'Payment provider unreachable',
        false,
        'NETWORK',
      ); // outcome UNKNOWN
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new PaymentProviderError(
        'Unreadable provider response',
        false,
        'BAD_RESPONSE',
      );
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; description?: string } })
        .error;
      // 4xx = definitive rejection; 5xx / 429 = the provider may or may not have acted.
      throw new PaymentProviderError(
        err?.description ?? `Provider error ${res.status}`,
        res.status >= 400 && res.status < 500 && res.status !== 429,
        err?.code,
      );
    }
    return json;
  }
}

interface RzpPayment {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  error_code?: string | null;
  error_description?: string | null;
  amount_refunded?: number;
}
interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
  receipt?: string | null;
}

const PAYMENT_STATUS: Record<string, ProviderPaymentStatus> = {
  created: 'created',
  authorized: 'authorized',
  captured: 'captured',
  failed: 'failed',
  refunded: 'refunded',
};
const REFUND_STATUS: Record<string, ProviderRefundStatus> = {
  pending: 'pending',
  processed: 'processed',
  failed: 'failed',
};

const hmacHex = (secret: string, data: string | Buffer): string =>
  createHmac('sha256', secret).update(data).digest('hex');
function safeHexEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const toProviderPayment = (p: RzpPayment): ProviderPayment => ({
  id: p.id,
  orderId: p.order_id ?? null,
  amountMinor: p.amount,
  currency: p.currency,
  // Unknown provider states are treated as "created" (no money movement is ever inferred from a status we do not understand).
  status: PAYMENT_STATUS[p.status] ?? 'created',
  method: p.method ?? null,
  errorCode: p.error_code ?? null,
  errorDescription: p.error_description
    ? p.error_description.slice(0, 300)
    : null,
  amountRefundedMinor: p.amount_refunded ?? 0,
});
export const toProviderRefund = (r: RzpRefund): ProviderRefund => ({
  id: r.id,
  paymentId: r.payment_id,
  amountMinor: r.amount,
  status: REFUND_STATUS[r.status] ?? 'pending',
  receipt: r.receipt ?? null,
});

@Injectable()
export class RazorpayAdapter extends PaymentProvider {
  readonly name = 'razorpay';

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly http: RazorpayHttp,
  ) {
    super();
  }

  private get keySecret(): string {
    const s = this.config.get('RAZORPAY_KEY_SECRET', { infer: true });
    if (!s)
      throw new PaymentProviderError(
        'Payments are not configured',
        true,
        'NOT_CONFIGURED',
      );
    return s;
  }

  async createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<ProviderOrder> {
    const o = (await this.http.request('POST', '/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
    })) as { id: string; amount: number; currency: string };
    return {
      providerOrderId: o.id,
      amountMinor: o.amount,
      currency: o.currency,
    };
  }

  async fetchPayment(id: string): Promise<ProviderPayment> {
    return toProviderPayment(
      (await this.http.request(
        'GET',
        `/payments/${encodeURIComponent(id)}`,
      )) as RzpPayment,
    );
  }

  async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const r = (await this.http.request(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    )) as { items?: RzpPayment[] };
    return (r.items ?? []).map(toProviderPayment);
  }

  async capturePayment(
    id: string,
    amountMinor: number,
    currency: string,
  ): Promise<ProviderPayment> {
    return toProviderPayment(
      (await this.http.request(
        'POST',
        `/payments/${encodeURIComponent(id)}/capture`,
        { amount: amountMinor, currency },
      )) as RzpPayment,
    );
  }

  async createRefund(input: {
    providerPaymentId: string;
    amountMinor: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<ProviderRefund> {
    return toProviderRefund(
      (await this.http.request(
        'POST',
        `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
        {
          amount: input.amountMinor,
          speed: 'normal',
          receipt: input.receipt,
          notes: input.notes ?? {},
        },
      )) as RzpRefund,
    );
  }

  async listRefunds(paymentId: string): Promise<ProviderRefund[]> {
    const r = (await this.http.request(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}/refunds`,
    )) as { items?: RzpRefund[] };
    return (r.items ?? []).map(toProviderRefund);
  }

  /** Razorpay: HMAC-SHA256(`${order_id}|${payment_id}`, key_secret), hex. */
  verifyCheckoutSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean {
    if (!/^[0-9a-f]{64}$/i.test(input.signature)) return false;
    return safeHexEqual(
      hmacHex(
        this.keySecret,
        `${input.providerOrderId}|${input.providerPaymentId}`,
      ),
      input.signature.toLowerCase(),
    );
  }

  /** Razorpay: HMAC-SHA256(rawBody, webhook_secret), hex, in `X-Razorpay-Signature`. Must be the RAW bytes, not re-serialised JSON. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    const secret = this.config.get('RAZORPAY_WEBHOOK_SECRET', { infer: true });
    if (!secret || !signature || !/^[0-9a-f]{64}$/i.test(signature))
      return false;
    return safeHexEqual(hmacHex(secret, rawBody), signature.toLowerCase());
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ProviderWebhookEvent | null {
    let body: {
      event?: string;
      created_at?: number;
      payload?: {
        payment?: { entity?: RzpPayment };
        refund?: { entity?: RzpRefund };
      };
    };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const idHeader = headers['x-razorpay-event-id'];
    const id = Array.isArray(idHeader) ? idHeader[0] : idHeader;
    if (
      !id ||
      !/^[A-Za-z0-9_-]{6,80}$/.test(id) ||
      typeof body.event !== 'string' ||
      typeof body.created_at !== 'number'
    )
      return null;
    const payment = body.payload?.payment?.entity;
    const refund = body.payload?.refund?.entity;
    return {
      id,
      type: body.event,
      createdAt: body.created_at,
      ...(payment ? { payment: toProviderPayment(payment) } : {}),
      ...(refund ? { refund: toProviderRefund(refund) } : {}),
    };
  }

  publicConfig(): { keyId: string } {
    const keyId = this.config.get('RAZORPAY_KEY_ID', { infer: true });
    if (!keyId)
      throw new PaymentProviderError(
        'Payments are not configured',
        true,
        'NOT_CONFIGURED',
      );
    return { keyId };
  }
}

export { hmacHex as razorpayHmacHex };
