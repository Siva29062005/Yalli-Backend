import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { EmailTransport, type OutboundEmail } from '../ports/ports.js';

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
    }),
  ) {
    super();
    this.from = config.get('SES_FROM_ADDRESS', { infer: true }) ?? '';
    this.configurationSet = config.get('SES_CONFIGURATION_SET', {
      infer: true,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
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
