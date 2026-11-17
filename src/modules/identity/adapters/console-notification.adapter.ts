import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { NotificationPort, type NotificationMessage } from '../ports/ports.js';

const mask = (v: string): string => v.replace(/^(.).*(.@|.{2}$)/, '$1***$2');

/**
 * LOCAL DEVELOPMENT ONLY. Prints one-time links/codes to the console so flows can be exercised by hand.
 * Production env validation rejects this driver; real email/SMS adapters (SES, MSG91) arrive in Phase 6.
 */
@Injectable()
export class ConsoleNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('Notification');
  private readonly base: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.base = config.get('FRONTEND_BASE_URL', { infer: true });
  }

  send(m: NotificationMessage): Promise<void> {
    const to = 'email' in m ? mask(m.email) : mask(m.phone);
    switch (m.type) {
      case 'EMAIL_VERIFICATION':
        this.logger.log(
          `[DEV ONLY] ${m.type} to=${to} link=${this.base}/verify-email?token=${m.token}`,
        );
        break;
      case 'PASSWORD_RESET':
        this.logger.log(
          `[DEV ONLY] ${m.type} to=${to} link=${this.base}/reset-password?token=${m.token}`,
        );
        break;
      case 'PHONE_OTP':
        this.logger.log(`[DEV ONLY] ${m.type} to=${to} code=${m.code}`);
        break;
      default:
        this.logger.log(`[DEV ONLY] ${m.type} to=${to}`);
    }
    return Promise.resolve();
  }
}
