import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { stripTags } from '../../common/utils/sanitize-html.js';
import type { ContactTopic } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { CaptchaVerifier, NotificationPort } from '../identity/ports/ports.js';

export const CONTACT_TOPIC_LABEL: Record<ContactTopic, string> = {
  ORDER: 'An order',
  RETURN: 'A return or refund',
  PAYMENT: 'A payment',
  ACCOUNT: 'My account',
  PRODUCT: 'A product',
  OTHER: 'Something else',
};

export interface ContactInput {
  name: string;
  email: string;
  orderNumber?: string | undefined;
  topic: ContactTopic;
  message: string;
  captchaToken?: string | undefined;
  /** Honeypot: hidden from people, filled in by bots. */
  website?: string | undefined;
}

/**
 * The website's contact form. Messages are stored (staff read them in the admin, Phase 11) and, when SUPPORT_INBOX_EMAIL
 * is set, emailed to support on a best-effort basis: a delivery problem never loses the message.
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  private readonly inbox: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly captcha: CaptchaVerifier,
    private readonly notifications: NotificationPort,
  ) {
    this.inbox = config.get('SUPPORT_INBOX_EMAIL', { infer: true });
  }

  async submit(input: ContactInput, ip: string | null): Promise<void> {
    if (!(await this.captcha.verify(input.captchaToken, ip)))
      throw new BadRequestException({
        message: 'Please complete the security check and try again',
        code: 'CAPTCHA_FAILED',
      });
    if (input.website) return; // a bot filled the hidden field: accept silently, store nothing
    const message = stripTags(input.message)
      .replace(/[ \t]+/g, ' ')
      .trim();
    const name = stripTags(input.name).replace(/\s+/g, ' ').trim();
    if (message.length < 10 || name.length === 0)
      throw new BadRequestException({
        message: 'Please tell us a little more (at least 10 characters).',
        code: ErrorCode.ValidationFailed,
      });
    const saved = await this.prisma.contactMessage.create({
      data: {
        name,
        email: input.email,
        orderNumber: input.orderNumber ?? null,
        topic: input.topic,
        message,
      },
      select: { id: true },
    });
    if (!this.inbox) return;
    await this.notifications
      .send({
        type: 'CONTACT_MESSAGE',
        email: this.inbox,
        name: 'Support',
        fromName: name,
        fromEmail: input.email,
        topic: CONTACT_TOPIC_LABEL[input.topic],
        orderNumber: input.orderNumber ?? null,
        message,
      })
      .catch((err) =>
        this.logger.error(
          { err: (err as Error).message, messageId: saved.id },
          'Contact message email failed',
        ),
      );
  }
}
