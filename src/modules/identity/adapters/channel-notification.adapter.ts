import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import {
  EmailTransport,
  NotificationPort,
  SmsTransport,
  type NotificationMessage,
} from '../ports/ports.js';
import { creditNoteAttachment } from './credit-note-document.js';
import { renderEmail, type EmailMessage } from './notification-templates.js';

const mask = (v: string): string => v.replace(/^(.).*(.@|.{2}$)/, '$1***$2');

/** Messages whose failure must be visible to the caller so it can retry (order events are redelivered; OTP is a request). */
const RETRYABLE: ReadonlySet<NotificationMessage['type']> = new Set([
  'ORDER_CONFIRMED',
  'PAYMENT_FAILED',
  'ORDER_SHIPPED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'REFUND_PROCESSED',
  'RETURN_UPDATE',
  'PHONE_OTP',
]);

/**
 * Production notifier: emails via {@link EmailTransport}, OTP SMS via {@link SmsTransport}.
 * Account-security emails are best-effort and never throw (so a delivery problem cannot reveal whether an account
 * exists); order messages and OTPs throw so the caller retries. Nothing here logs a token, code or full address.
 */
@Injectable()
export class ChannelNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('Notification');
  private readonly frontendBaseUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly email: EmailTransport,
    private readonly sms: SmsTransport,
  ) {
    super();
    this.frontendBaseUrl = config.get('FRONTEND_BASE_URL', { infer: true });
  }

  async send(m: NotificationMessage): Promise<void> {
    const to = m.type === 'PHONE_OTP' ? m.phone : m.email;
    try {
      if (m.type === 'PHONE_OTP') await this.sms.sendOtp(m.phone, m.code);
      else await this.sendEmail(m);
    } catch (err) {
      this.logger.error(
        { type: m.type, to: mask(to), err: (err as Error).message },
        'Notification delivery failed',
      );
      if (RETRYABLE.has(m.type)) throw err;
    }
  }

  private async sendEmail(m: EmailMessage): Promise<void> {
    const r = renderEmail(m, { frontendBaseUrl: this.frontendBaseUrl });
    const attachments =
      m.type === 'REFUND_PROCESSED' && m.creditNote
        ? [creditNoteAttachment(m.creditNote)]
        : undefined;
    await this.email.send({
      to: m.email,
      ...r,
      ...(attachments ? { attachments } : {}),
    });
  }
}
