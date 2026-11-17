/**
 * Provider-independent payment port. Application code never sees Razorpay (or Stripe/PayU) types:
 * adapters translate to these shapes and to our internal status model.
 */
export type ProviderPaymentStatus =
  'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
export type ProviderRefundStatus = 'pending' | 'processed' | 'failed';

export interface ProviderOrder {
  providerOrderId: string;
  amountMinor: number;
  currency: string;
}

export interface ProviderPayment {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  status: ProviderPaymentStatus;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  amountRefundedMinor: number;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: ProviderRefundStatus;
  receipt: string | null;
}

export interface ProviderWebhookEvent {
  /** Provider's unique event id (the de-duplication key). */
  id: string;
  type: string;
  /** Epoch seconds the provider created the event. */
  createdAt: number;
  payment?: ProviderPayment;
  refund?: ProviderRefund;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    /** true = the provider definitively rejected the request; false = outcome unknown (timeout, 5xx, network). */
    readonly definitive: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}

export abstract class PaymentProvider {
  abstract readonly name: string;
  abstract createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<ProviderOrder>;
  abstract fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  abstract fetchOrderPayments(
    providerOrderId: string,
  ): Promise<ProviderPayment[]>;
  abstract capturePayment(
    providerPaymentId: string,
    amountMinor: number,
    currency: string,
  ): Promise<ProviderPayment>;
  abstract createRefund(input: {
    providerPaymentId: string;
    amountMinor: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<ProviderRefund>;
  abstract listRefunds(providerPaymentId: string): Promise<ProviderRefund[]>;
  /** Checks the signature the browser received after paying. Necessary, NOT sufficient: callers must still fetch the payment. */
  abstract verifyCheckoutSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean;
  /** Verifies the webhook signature over the EXACT raw request bytes (constant-time compare). */
  abstract verifyWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean;
  abstract parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ProviderWebhookEvent | null;
  /** Public identifiers the browser SDK needs (never secrets). */
  abstract publicConfig(): { keyId: string };
}
