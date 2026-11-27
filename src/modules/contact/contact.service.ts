import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
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

/** Stored messages per sender address per hour (after the captcha). */
const MAX_PER_EMAIL_PER_HOUR = 3;

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
    // Count CHARACTERS (code points), as Zod and PostgreSQL do: "😀".length is 2 in JavaScript.
    if ([...message].length < 10 || name.length === 0)
      throw new BadRequestException({
        message: 'Please tell us a little more (at least 10 characters).',
        code: ErrorCode.ValidationFailed,
      });
    // Per-address cap, counted only AFTER the captcha passed: nobody can burn someone else's budget with junk requests.
    const recent = await this.prisma.contactMessage.count({
      where: {
        email: input.email,
        createdAt: { gt: new Date(Date.now() - 3_600_000) },
      },
    });
    if (recent >= MAX_PER_EMAIL_PER_HOUR)
      throw new HttpException(
        {
          message:
            'You have sent several messages already. We will reply to them soon.',
          code: ErrorCode.TooManyRequests,
        },
        429,
      );
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
    // Not awaited: the message is stored; a slow mail service must not hold the customer's request open. The channel
    // adapter logs (masked) and swallows delivery failures for this type.
    void this.notifications
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
