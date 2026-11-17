import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { SmsTransport } from '../ports/ports.js';

const ENDPOINT = 'https://control.msg91.com/api/v5/flow';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * MSG91 "Flow" API: sends a DLT-approved template whose single variable is `otp`.
 * The auth key travels in a header (never in the URL, so it cannot leak through logs), the request is bounded by a
 * timeout, and error messages never include the key. Not verified against a live MSG91 account yet (see docs).
 */
@Injectable()
export class Msg91SmsTransport extends SmsTransport {
  private readonly authKey: string;
  private readonly templateId: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly doFetch: Fetch = (url, init) => fetch(url, init),
  ) {
    super();
    this.authKey = config.get('MSG91_AUTH_KEY', { infer: true }) ?? '';
    this.templateId =
      config.get('MSG91_OTP_TEMPLATE_ID', { infer: true }) ?? '';
  }

  async sendOtp(phoneE164: string, code: string): Promise<void> {
    // MSG91 wants the number with country code and no "+".
    const mobiles = phoneE164.replace(/^\+/, '');
    if (!/^\d{8,15}$/.test(mobiles)) throw new Error('Invalid phone number');
    let res: Response;
    try {
      res = await this.doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authkey: this.authKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          template_id: this.templateId,
          short_url: '0',
          recipients: [{ mobiles, otp: code }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      throw new Error(`MSG91 request failed: ${(err as Error).name}`);
    }
    let body: { type?: string } | null = null;
    try {
      body = (await res.json()) as { type?: string };
    } catch {
      body = null;
    }
    if (!res.ok || body?.type !== 'success')
      throw new Error(`MSG91 rejected the message (HTTP ${res.status})`);
  }
}
