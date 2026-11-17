import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../config/env.js';
import {
  EmailTransport,
  SmsTransport,
  type OutboundEmail,
} from '../ports/ports.js';
import { ChannelNotificationAdapter } from './channel-notification.adapter.js';
import { Msg91SmsTransport } from './msg91-sms.transport.js';
import { SesEmailTransport } from './ses-email.transport.js';

const cfg = (extra: Record<string, unknown> = {}) =>
  ({
    get: (k: string) =>
      ({
        FRONTEND_BASE_URL: 'https://yalli.in',
        AWS_REGION: 'ap-south-1',
        SES_FROM_ADDRESS: 'no-reply@yalli.in',
        MSG91_AUTH_KEY: 'AUTHKEY-SECRET-1234',
        MSG91_OTP_TEMPLATE_ID: 'tmpl_123',
        ...extra,
      })[k],
  }) as unknown as ConfigService<Env, true>;

describe('SesEmailTransport', () => {
  it('sends a structured SES v2 message (no raw headers) from the configured identity', async () => {
    const send = vi.fn().mockResolvedValue({});
    const t = new SesEmailTransport(
      cfg({ SES_CONFIGURATION_SET: 'yalli-prod' }),
      { send } as Pick<SESv2Client, 'send'>,
    );
    await t.send({
      to: 'a@example.com',
      subject: 'Hi',
      text: 'T',
      html: '<p>H</p>',
    });
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> })
      .input;
    expect(input).toMatchObject({
      FromEmailAddress: 'no-reply@yalli.in',
      Destination: { ToAddresses: ['a@example.com'] },
      ConfigurationSetName: 'yalli-prod',
      Content: {
        Simple: {
          Subject: { Data: 'Hi' },
          Body: { Text: { Data: 'T' }, Html: { Data: '<p>H</p>' } },
        },
      },
    });
  });
  it('omits the configuration set when none is configured, and propagates failures', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttling'));
    const t = new SesEmailTransport(cfg(), { send } as Pick<
      SESv2Client,
      'send'
    >);
    await expect(
      t.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow('Throttling');
    expect(
      (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input,
    ).not.toHaveProperty('ConfigurationSetName');
  });
});

describe('Msg91SmsTransport', () => {
  const ok = () =>
    Promise.resolve(
      new Response(JSON.stringify({ type: 'success', message: 'id' }), {
        status: 200,
      }),
    );
  it('posts the template with the key in a HEADER, number without "+", and the code as `otp`', async () => {
    const doFetch = vi.fn().mockImplementation(ok);
    await new Msg91SmsTransport(cfg(), doFetch).sendOtp(
      '+919876543210',
      '123456',
    );
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect(url).not.toContain('AUTHKEY');
    expect((init.headers as Record<string, string>)['authkey']).toBe(
      'AUTHKEY-SECRET-1234',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      template_id: 'tmpl_123',
      short_url: '0',
      recipients: [{ mobiles: '919876543210', otp: '123456' }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('fails on HTTP errors, an application-level error body, and network errors - without leaking the key', async () => {
    for (const doFetch of [
      vi
        .fn()
        .mockResolvedValue(new Response('{"type":"error"}', { status: 200 })),
      vi
        .fn()
        .mockResolvedValue(new Response('{"type":"success"}', { status: 500 })),
      vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
      vi
        .fn()
        .mockRejectedValue(
          new Error('connect ECONNREFUSED authkey=AUTHKEY-SECRET-1234'),
        ),
    ]) {
      const err = await new Msg91SmsTransport(cfg(), doFetch)
        .sendOtp('+919876543210', '1')
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toContain('AUTHKEY-SECRET');
    }
  });
  it('refuses a malformed number before calling the provider', async () => {
    const doFetch = vi.fn();
    await expect(
      new Msg91SmsTransport(cfg(), doFetch).sendOtp('not-a-number', '1'),
    ).rejects.toThrow('Invalid phone number');
    expect(doFetch).not.toHaveBeenCalled();
  });
});

class FakeEmail extends EmailTransport {
  sent: OutboundEmail[] = [];
  fail = false;
  send(e: OutboundEmail): Promise<void> {
    if (this.fail) return Promise.reject(new Error('SES down'));
    this.sent.push(e);
    return Promise.resolve();
  }
}
class FakeSms extends SmsTransport {
  sent: { phone: string; code: string }[] = [];
  fail = false;
  sendOtp(phone: string, code: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error('MSG91 down'));
    this.sent.push({ phone, code });
    return Promise.resolve();
  }
}

describe('ChannelNotificationAdapter', () => {
  const make = () => {
    const email = new FakeEmail();
    const sms = new FakeSms();
    return {
      email,
      sms,
      adapter: new ChannelNotificationAdapter(cfg(), email, sms),
    };
  };
  const base = { email: 'a@example.com', name: 'Asha' };

  it('routes emails to the email transport and OTPs to SMS', async () => {
    const { email, sms, adapter } = make();
    await adapter.send({
      type: 'ORDER_SHIPPED',
      ...base,
      orderNumber: 'YL26-1',
    });
    await adapter.send({
      type: 'PHONE_OTP',
      phone: '+919876543210',
      code: '424242',
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: 'a@example.com' });
    expect(email.sent[0]!.subject).toContain('YL26-1');
    expect(sms.sent).toEqual([{ phone: '+919876543210', code: '424242' }]);
  });

  it('account-security email failures are swallowed (no account-existence signal)', async () => {
    const { email, adapter } = make();
    email.fail = true;
    for (const m of [
      { type: 'EMAIL_VERIFICATION', ...base, token: 't' },
      { type: 'ACCOUNT_ALREADY_EXISTS', ...base },
      { type: 'PASSWORD_RESET', ...base, token: 't' },
    ] as const)
      await expect(adapter.send(m)).resolves.toBeUndefined();
  });

  it('order messages and OTPs throw so the caller can retry', async () => {
    const { email, sms, adapter } = make();
    email.fail = true;
    sms.fail = true;
    await expect(
      adapter.send({
        type: 'ORDER_CONFIRMED',
        ...base,
        orderNumber: 'YL26-1',
        totalMinor: 100,
      }),
    ).rejects.toThrow('SES down');
    await expect(
      adapter.send({
        type: 'REFUND_PROCESSED',
        ...base,
        orderNumber: 'YL26-1',
        amountMinor: 100,
      }),
    ).rejects.toThrow('SES down');
    await expect(
      adapter.send({ type: 'PHONE_OTP', phone: '+919876543210', code: '1' }),
    ).rejects.toThrow('MSG91 down');
  });

  it('never writes tokens, codes or full addresses to the log', async () => {
    const { email, sms, adapter } = make();
    email.fail = true;
    sms.fail = true;
    const logged: string[] = [];
    const spy = vi
      .spyOn(
        (adapter as unknown as { logger: { error: (...a: unknown[]) => void } })
          .logger,
        'error',
      )
      .mockImplementation(
        (...a: unknown[]) => void logged.push(JSON.stringify(a)),
      );
    await adapter.send({ type: 'PASSWORD_RESET', ...base, token: 'TOKEN-ABC' });
    await adapter
      .send({ type: 'PHONE_OTP', phone: '+919876543210', code: '777888' })
      .catch(() => undefined);
    spy.mockRestore();
    const out = logged.join('');
    expect(out).not.toContain('TOKEN-ABC');
    expect(out).not.toContain('777888');
    expect(out).not.toContain('a@example.com');
    expect(out).not.toContain('+919876543210');
  });
});
