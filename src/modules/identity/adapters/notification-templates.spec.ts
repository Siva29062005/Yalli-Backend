import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatInr,
  renderEmail,
  type EmailMessage,
} from './notification-templates.js';

const opts = { frontendBaseUrl: 'https://yalli.in/' };
const base = { email: 'a@example.com', name: 'Asha' };

const ALL: EmailMessage[] = [
  { type: 'EMAIL_VERIFICATION', ...base, token: 'tok' },
  { type: 'ACCOUNT_ALREADY_EXISTS', ...base },
  { type: 'PASSWORD_RESET', ...base, token: 'tok' },
  { type: 'PASSWORD_CHANGED', ...base },
  { type: 'ACCOUNT_LOCKED', ...base, minutes: 15 },
  { type: 'NEW_DEVICE_LOGIN', ...base, device: 'Chrome on Mac', ip: '1.2.3.4' },
  { type: 'SESSION_THEFT_SUSPECTED', ...base },
  { type: 'MFA_ENABLED', ...base },
  { type: 'MFA_DISABLED', ...base },
  {
    type: 'ORDER_CONFIRMED',
    ...base,
    orderNumber: 'YL26-1001',
    totalMinor: 123456,
  },
  { type: 'PAYMENT_FAILED', ...base, orderNumber: 'YL26-1001' },
  { type: 'ORDER_SHIPPED', ...base, orderNumber: 'YL26-1001' },
  { type: 'ORDER_DELIVERED', ...base, orderNumber: 'YL26-1001' },
  { type: 'ORDER_CANCELLED', ...base, orderNumber: 'YL26-1001' },
  {
    type: 'REFUND_PROCESSED',
    ...base,
    orderNumber: 'YL26-1001',
    amountMinor: 59000,
  },
  {
    type: 'RETURN_UPDATE',
    ...base,
    orderNumber: 'YL26-1001',
    status: 'APPROVED',
  },
];

describe('formatInr', () => {
  it('formats paise with Indian grouping and no floating point', () => {
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(99900)).toBe('₹999.00');
    expect(formatInr(123456)).toBe('₹1,234.56');
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(formatInr(1_000_000_000)).toBe('₹1,00,00,000.00');
  });
  it('rejects non-integers and negatives', () => {
    expect(() => formatInr(10.5)).toThrow(RangeError);
    expect(() => formatInr(-1)).toThrow(RangeError);
  });
});

describe('renderEmail', () => {
  it('has a template for every email type, each with subject, text and html', () => {
    for (const m of ALL) {
      const r = renderEmail(m, opts);
      expect(r.subject.length).toBeGreaterThan(3);
      expect(r.text).toContain('Yalli');
      expect(r.html.startsWith('<!doctype html>')).toBe(true);
    }
    // keeps the list above honest: it must cover every non-SMS message type
    const types = new Set(ALL.map((m) => m.type));
    const need: EmailMessage['type'][] = [
      'EMAIL_VERIFICATION',
      'ACCOUNT_ALREADY_EXISTS',
      'PASSWORD_RESET',
      'PASSWORD_CHANGED',
      'ACCOUNT_LOCKED',
      'NEW_DEVICE_LOGIN',
      'SESSION_THEFT_SUSPECTED',
      'MFA_ENABLED',
      'MFA_DISABLED',
      'ORDER_CONFIRMED',
      'PAYMENT_FAILED',
      'ORDER_SHIPPED',
      'ORDER_DELIVERED',
      'ORDER_CANCELLED',
      'REFUND_PROCESSED',
      'RETURN_UPDATE',
    ];
    for (const t of need) expect(types.has(t)).toBe(true);
  });

  it('builds token links from the frontend URL and URL-encodes the token', () => {
    const r = renderEmail(
      { type: 'PASSWORD_RESET', ...base, token: 'a b&c=d/é' },
      opts,
    );
    expect(r.text).toContain(
      'https://yalli.in/reset-password?token=a%20b%26c%3Dd%2F%C3%A9',
    );
    expect(r.html).toContain('reset-password?token=a%20b%26c%3Dd%2F%C3%A9');
  });

  it('never puts a token in the subject', () => {
    for (const type of ['EMAIL_VERIFICATION', 'PASSWORD_RESET'] as const) {
      const r = renderEmail({ type, ...base, token: 'SECRET-TOKEN' }, opts);
      expect(r.subject).not.toContain('SECRET-TOKEN');
    }
  });

  it('escapes every dynamic value in HTML', () => {
    const evil = '<script>alert(1)</script>"\'&';
    const r = renderEmail(
      {
        type: 'NEW_DEVICE_LOGIN',
        email: 'a@example.com',
        name: evil,
        device: evil,
        ip: evil,
      },
      opts,
    );
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    const o = renderEmail(
      { type: 'ORDER_SHIPPED', ...base, name: evil, orderNumber: evil },
      opts,
    );
    expect(o.html).not.toContain('<script>');
  });

  it('keeps header injection out of the subject', () => {
    const r = renderEmail(
      {
        type: 'ORDER_SHIPPED',
        ...base,
        orderNumber: 'YL1\r\nBcc: evil@example.com',
      },
      opts,
    );
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it('shows amounts from integer paise', () => {
    const r = renderEmail(
      {
        type: 'ORDER_CONFIRMED',
        ...base,
        orderNumber: 'YL26-1',
        totalMinor: 123456,
      },
      opts,
    );
    expect(r.text).toContain('₹1,234.56');
  });

  it('escapeHtml covers the five dangerous characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
