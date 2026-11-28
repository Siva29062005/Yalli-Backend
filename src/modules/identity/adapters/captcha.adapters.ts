import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { CaptchaVerifier, type CaptchaAction } from '../ports/ports.js';

/** Development only (rejected in production by env validation). */
@Injectable()
export class NoopCaptchaVerifier extends CaptchaVerifier {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** The storefront's host names: a token solved on any other site is refused. */
export function storefrontHostnames(
  frontendBaseUrl: string,
  corsOrigins: readonly string[],
): Set<string> {
  const hosts = new Set<string>();
  for (const url of [frontendBaseUrl, ...corsOrigins]) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // not a URL: contributes no host
    }
  }
  return hosts;
}

/**
 * Cloudflare's dummy secret keys (always pass / always fail / token spent). Their answers carry `hostname: example.com`
 * and no `action`, so with one only `success` is checked; production refuses them (env validation).
 */
export const isTurnstileTestSecret = (secret: string): boolean =>
  /^[123]x0{31}AA$/.test(secret);

interface SiteverifyAnswer {
  success?: boolean;
  action?: string;
  hostname?: string;
}

/** Pure decision on Cloudflare's siteverify answer (unit-tested). */
export function acceptTurnstile(
  answer: SiteverifyAnswer,
  action: CaptchaAction,
  hostnames: ReadonlySet<string>,
  testSecret = false,
): boolean {
  if (testSecret) return answer.success === true;
  return (
    answer.success === true &&
    answer.action === action &&
    typeof answer.hostname === 'string' &&
    hostnames.has(answer.hostname.toLowerCase())
  );
}

@Injectable()
export class TurnstileCaptchaVerifier extends CaptchaVerifier {
  private readonly logger = new Logger(TurnstileCaptchaVerifier.name);
  private readonly secret: string;
  private readonly hostnames: Set<string>;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.secret = config.get('TURNSTILE_SECRET', { infer: true }) ?? '';
    this.hostnames = storefrontHostnames(
      config.get('FRONTEND_BASE_URL', { infer: true }),
      config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    );
  }

  async verify(
    token: string | undefined,
    ip: string | null,
    action: CaptchaAction,
  ): Promise<boolean> {
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
      const answer = (await res.json()) as SiteverifyAnswer;
      const ok = acceptTurnstile(
        answer,
        action,
        this.hostnames,
        isTurnstileTestSecret(this.secret),
      );
      if (!ok && answer.success === true)
        // solved, but for another form or site: worth seeing in the logs (names only, never the token)
        this.logger.warn(
          {
            expectedAction: action,
            action: String(answer.action).slice(0, 40),
          },
          'Captcha token for another form or site refused',
        );
      return ok;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).name },
        'Captcha verification failed (closed)',
      );
      return false;
    }
  }
}
