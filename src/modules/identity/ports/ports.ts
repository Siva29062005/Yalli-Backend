/** External capabilities are behind ports so providers can be swapped (and faked in tests). */

export abstract class CaptchaVerifier {
  /** Must fail CLOSED: any error or ambiguity => false. */
  abstract verify(
    token: string | undefined,
    ip: string | null,
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

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
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
