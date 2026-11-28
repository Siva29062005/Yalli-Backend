import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import {
  acceptTurnstile,
  isTurnstileTestSecret,
  storefrontHostnames,
  TurnstileCaptchaVerifier,
} from './captcha.adapters.js';

const hosts = storefrontHostnames('https://yalli.in', [
  'https://yalli.in',
  'https://www.yalli.in',
]);

describe('Turnstile answer checks', () => {
  it('takes the host names from the storefront address and the CORS origins', () => {
    expect([...hosts].sort()).toEqual(['www.yalli.in', 'yalli.in']);
    expect([...storefrontHostnames('not a url', [])]).toEqual([]);
  });

  it('accepts only a solved token for the same form on our site', () => {
    const ok = { success: true, action: 'register', hostname: 'yalli.in' };
    expect(acceptTurnstile(ok, 'register', hosts)).toBe(true);
    expect(
      acceptTurnstile({ ...ok, hostname: 'WWW.YALLI.IN' }, 'register', hosts),
    ).toBe(true);
    // solved for the contact form, replayed on sign-up
    expect(acceptTurnstile(ok, 'contact', hosts)).toBe(false);
    // solved on another site that embeds our site key
    expect(
      acceptTurnstile({ ...ok, hostname: 'evil.example' }, 'register', hosts),
    ).toBe(false);
    expect(
      acceptTurnstile({ success: true, action: 'register' }, 'register', hosts),
    ).toBe(false);
    expect(acceptTurnstile({ ...ok, success: false }, 'register', hosts)).toBe(
      false,
    );
  });

  it("with Cloudflare's test secret only success counts (its answers have no action and say example.com)", () => {
    expect(isTurnstileTestSecret('1x0000000000000000000000000000000AA')).toBe(
      true,
    );
    expect(isTurnstileTestSecret('0x4AAAAAAAreal-secret-value')).toBe(false);
    const dummy = { success: true, hostname: 'example.com' };
    expect(acceptTurnstile(dummy, 'register', hosts, true)).toBe(true);
    expect(acceptTurnstile(dummy, 'register', hosts, false)).toBe(false);
    expect(acceptTurnstile({ success: false }, 'register', hosts, true)).toBe(
      false,
    );
  });
});

describe('TurnstileCaptchaVerifier', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = {
    get: (k: string) =>
      ({
        TURNSTILE_SECRET: '0x4AAAAAAAreal-secret-value',
        FRONTEND_BASE_URL: 'https://yalli.in',
        CORS_ALLOWED_ORIGINS: ['https://yalli.in'],
      })[k],
  } as unknown as ConfigService<Env, true>;
  const answer = (body: unknown) =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body))));

  it('passes the expected action through to the decision', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        success: true,
        action: 'forgot_password',
        hostname: 'yalli.in',
      }),
    );
    const v = new TurnstileCaptchaVerifier(config);
    expect(await v.verify('tok', null, 'forgot_password')).toBe(true);
    expect(await v.verify('tok', null, 'register')).toBe(false);
  });

  it('fails closed on a network error or without a token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const v = new TurnstileCaptchaVerifier(config);
    expect(await v.verify('tok', null, 'contact')).toBe(false);
    expect(await v.verify(undefined, null, 'contact')).toBe(false);
  });
});
