import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { EmailTransport, type OutboundEmail } from '../ports/ports.js';
import { buildMimeMessage } from './mime.js';

/**
 * Amazon SES v2. Credentials come from the default AWS provider chain (an IAM role in production): there is NO access
 * key in the application's configuration. Not verified against a live SES account yet (see docs).
 */
@Injectable()
export class SesEmailTransport extends EmailTransport {
  private readonly from: string;
  private readonly configurationSet: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    private readonly client: Pick<SESv2Client, 'send'> = new SESv2Client({
      region: config.get('AWS_REGION', { infer: true }),
      maxAttempts: 3,
      // Bounded: a slow SES must not hold requests or consumers for minutes.
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    }),
  ) {
    super();
    this.from = config.get('SES_FROM_ADDRESS', { infer: true }) ?? '';
    this.configurationSet = config.get('SES_CONFIGURATION_SET', {
      infer: true,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    // With attachments (the credit note on a refund email), SES takes the whole MIME message.
    if (email.attachments?.length) {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [email.to] },
          Content: {
            Raw: {
              Data: Buffer.from(buildMimeMessage(this.from, email), 'utf8'),
            },
          },
          ...(this.configurationSet
            ? { ConfigurationSetName: this.configurationSet }
            : {}),
        }),
      );
      return;
    }
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: email.text, Charset: 'UTF-8' },
              Html: { Data: email.html, Charset: 'UTF-8' },
            },
          },
        },
        ...(this.configurationSet
          ? { ConfigurationSetName: this.configurationSet }
          : {}),
      }),
    );
  }
}
