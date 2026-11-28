/** External capabilities are behind ports so providers can be swapped (and faked in tests). */

/** The form a captcha was solved for (the widget's `action`, checked by the server). */
export type CaptchaAction = 'register' | 'forgot_password' | 'contact';

export abstract class CaptchaVerifier {
  /**
   * Must fail CLOSED: any error or ambiguity => false. A token solved for another form (`action`) or on another site
   * (hostname) is refused.
   */
  abstract verify(
    token: string | undefined,
    ip: string | null,
    action: CaptchaAction,
  ): Promise<boolean>;
}

export abstract class BreachedPasswordChecker {
  /** true => the password appears in a known breach corpus. Implementations may fail open (log) on outage. */
  abstract isBreached(password: string): Promise<boolean>;
}

export type NotificationMessage =
  | { type: 'EMAIL_VERIFICATION'; email: string; name: string; token: string }
  | { type: 'ACCOUNT_ALREADY_EXISTS'; email: string; name: string }
  | { type: 'PASSWORD_RESET'; email: string; name: string; token: string }
  | { type: 'PASSWORD_CHANGED'; email: string; name: string }
  | { type: 'ACCOUNT_LOCKED'; email: string; name: string; minutes: number }
  | {
      type: 'NEW_DEVICE_LOGIN';
      email: string;
      name: string;
      device: string;
      ip: string | null;
    }
  | { type: 'SESSION_THEFT_SUSPECTED'; email: string; name: string }
  | { type: 'MFA_ENABLED' | 'MFA_DISABLED'; email: string; name: string }
  | {
      type: 'ORDER_CONFIRMED';
      email: string;
      name: string;
      orderNumber: string;
      totalMinor: number;
    }
  | { type: 'PAYMENT_FAILED'; email: string; name: string; orderNumber: string }
  | {
      type: 'ORDER_SHIPPED' | 'ORDER_DELIVERED' | 'ORDER_CANCELLED';
      email: string;
      name: string;
      orderNumber: string;
    }
  | {
      type: 'REFUND_PROCESSED';
      email: string;
      name: string;
      orderNumber: string;
      amountMinor: number;
      /** The GST credit note for this refund, attached to the email (absent when the order was never invoiced). */
      creditNote?: CreditNoteDocument | undefined;
    }
  | {
      type: 'RETURN_UPDATE';
      email: string;
      name: string;
      orderNumber: string;
      status: string;
    }
  | {
      /** To the shop's support inbox (not to a customer): a message from the contact form. */
      type: 'CONTACT_MESSAGE';
      email: string;
      name: string;
      fromName: string;
      fromEmail: string;
      topic: string;
      orderNumber: string | null;
      message: string;
    }
  | { type: 'PHONE_OTP'; phone: string; code: string };

export interface EmailAttachment {
  /** Letters, digits, dot, dash and underscore only (it goes into a MIME header). */
  filename: string;
  contentType: 'text/html';
  content: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[] | undefined;
}

/** A credit note as it is printed (built by the orders module's CreditNoteService). */
export interface CreditNoteDocument {
  creditNoteNumber: string;
  issuedAt: Date | string;
  invoiceNumber: string;
  orderNumber: string;
  reason: string;
  taxDocument: boolean;
  seller: { name: string; state: string; gstin: string | null };
  buyer: { name: string; email: string };
  placeOfSupply: string;
  supply: 'INTRA_STATE' | 'INTER_STATE';
  lines: {
    description: string;
    hsn: string | null;
    gstRateBps: number;
    taxableValueMinor: number;
    cgstMinor: number;
    sgstMinor: number;
    igstMinor: number;
    totalMinor: number;
  }[];
  totals: {
    taxableValueMinor: number;
    cgstMinor: number;
    sgstMinor: number;
    igstMinor: number;
    totalMinor: number;
  };
}

/** Sends one email. Throws on failure (the caller decides whether that is retried or only logged). */
export abstract class EmailTransport {
  abstract send(email: OutboundEmail): Promise<void>;
}

/** Sends one OTP SMS. Throws on failure. */
export abstract class SmsTransport {
  abstract sendOtp(phoneE164: string, code: string): Promise<void>;
}

export abstract class NotificationPort {
  /**
   * Callers invoke this AFTER the database transaction commits. Account-security emails are best-effort (a failure is
   * logged, never thrown, so it cannot reveal whether an account exists). Order messages and OTPs THROW on failure so
   * the caller can retry (the order consumer is redelivered with backoff).
   */
  abstract send(message: NotificationMessage): Promise<void>;
}
