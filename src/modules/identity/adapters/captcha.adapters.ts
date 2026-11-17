import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { CaptchaVerifier } from '../ports/ports.js';

/** Development only (rejected in production by env validation). */
@Injectable()
export class NoopCaptchaVerifier extends CaptchaVerifier {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

@Injectable()
export class TurnstileCaptchaVerifier extends CaptchaVerifier {
  private readonly logger = new Logger(TurnstileCaptchaVerifier.name);
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.secret = config.get('TURNSTILE_SECRET', { infer: true }) ?? '';
  }

  async verify(token: string | undefined, ip: string | null): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    try {
      const body = new URLSearchParams({
        secret: this.secret,
        response: token,
      });
      if (ip) body.set('remoteip', ip);
      const res = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) return false;
      return ((await res.json()) as { success?: boolean }).success === true;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).name },
        'Captcha verification failed (closed)',
      );
      return false;
    }
  }
}
