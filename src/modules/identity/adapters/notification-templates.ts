import type { NotificationMessage } from '../ports/ports.js';

/**
 * Pure rendering of customer emails: no I/O, so escaping and content are unit-tested.
 * Rules: every dynamic value is HTML-escaped; links are built from the configured frontend URL with the token
 * URL-encoded; the subject never contains a token or user-controlled control characters; money is formatted from
 * integer paise without floating point.
 */
export type EmailMessage = Exclude<NotificationMessage, { type: 'PHONE_OTP' }>;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'Yalli';

export const escapeHtml = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Header-safe single line. */
const CONTROL_CHARS = new RegExp(
  String.raw`[\u0000-\u001f\u007f\u2028\u2029]+`,
  'g',
);
const oneLine = (v: string): string => v.replace(CONTROL_CHARS, ' ').trim();
/** 123456 paise -> "₹1,234.56" (Indian digit grouping). Integer maths only. */
export function formatInr(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new RangeError('amount must be a non-negative integer of paise');
  const rupees = Math.trunc(minor / 100);
  const paise = String(minor % 100).padStart(2, '0');
  const digits = String(rupees);
  const grouped =
    digits.length <= 3
      ? digits
      : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
  return `₹${grouped}.${paise}`;
}

interface Body {
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  footnote?: string;
}

function layout(subject: string, b: Body): RenderedEmail {
  const text = [
    b.heading,
    '',
    ...b.paragraphs,
    ...(b.cta ? ['', `${b.cta.label}: ${b.cta.url}`] : []),
    ...(b.footnote ? ['', b.footnote] : []),
    '',
    `- ${BRAND}`,
  ].join('\n');
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px">
<tr><td>
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(b.heading)}</h1>
${b.paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`).join('\n')}
${b.cta ? `<p style="margin:20px 0"><a href="${escapeHtml(b.cta.url)}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;display:inline-block">${escapeHtml(b.cta.label)}</a></p>` : ''}
${b.footnote ? `<p style="font-size:12px;color:#5b6475;margin:16px 0 0">${escapeHtml(b.footnote)}</p>` : ''}
<p style="font-size:12px;color:#5b6475;margin:24px 0 0">${escapeHtml(BRAND)} · yalli.in</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: oneLine(subject), text, html };
}

export function renderEmail(
  m: EmailMessage,
  opts: { frontendBaseUrl: string },
): RenderedEmail {
  const base = opts.frontendBaseUrl.replace(/\/$/, '');
  const hi = `Hi ${oneLine(m.name) || 'there'},`;
  const ignore =
    'If you did not do this, please secure your account or contact support.';
  switch (m.type) {
    case 'EMAIL_VERIFICATION':
      return layout(`Verify your ${BRAND} email`, {
        heading: 'Confirm your email address',
        paragraphs: [
          hi,
          'Please confirm your email to finish creating your account. The link works once and expires soon.',
        ],
        cta: {
          label: 'Verify email',
          url: `${base}/verify-email?token=${encodeURIComponent(m.token)}`,
        },
        footnote:
          'If you did not create an account, you can ignore this email.',
      });
    case 'ACCOUNT_ALREADY_EXISTS':
      return layout(`You already have a ${BRAND} account`, {
        heading: 'Someone tried to register with this email',
        paragraphs: [
          hi,
          'An account with this email already exists, so no new account was created. You can sign in, or reset your password if you have forgotten it.',
        ],
        cta: { label: 'Go to sign in', url: `${base}/login` },
        footnote: 'If this was not you, no action is needed.',
      });
    case 'PASSWORD_RESET':
      return layout(`Reset your ${BRAND} password`, {
        heading: 'Reset your password',
        paragraphs: [
          hi,
          'We received a request to reset your password. The link works once and expires soon.',
        ],
        cta: {
          label: 'Choose a new password',
          url: `${base}/reset-password?token=${encodeURIComponent(m.token)}`,
        },
        footnote:
          'If you did not ask for this, ignore this email: your password is unchanged.',
      });
    case 'PASSWORD_CHANGED':
      return layout('Your password was changed', {
        heading: 'Your password was changed',
        paragraphs: [
          hi,
          'The password on your account was just changed.',
          ignore,
        ],
      });
    case 'ACCOUNT_LOCKED':
      return layout('Your account is temporarily locked', {
        heading: 'Account temporarily locked',
        paragraphs: [
          hi,
          `Too many failed sign-in attempts locked your account for ${m.minutes} minutes.`,
          ignore,
        ],
      });
    case 'NEW_DEVICE_LOGIN':
      return layout('New sign-in to your account', {
        heading: 'New sign-in detected',
        paragraphs: [
          hi,
          `We noticed a sign-in from a new device: ${oneLine(m.device)}${m.ip ? ` (IP ${oneLine(m.ip)})` : ''}.`,
          ignore,
        ],
      });
    case 'SESSION_THEFT_SUSPECTED':
      return layout('Security alert: you were signed out', {
        heading: 'We signed you out for your safety',
        paragraphs: [
          hi,
          'We detected a suspicious reuse of your sign-in session and ended all your sessions.',
          'Please sign in again and change your password.',
        ],
        cta: { label: 'Sign in', url: `${base}/login` },
      });
    case 'MFA_ENABLED':
      return layout('Two-step verification turned on', {
        heading: 'Two-step verification is on',
        paragraphs: [
          hi,
          'Two-step verification was enabled on your account.',
          ignore,
        ],
      });
    case 'MFA_DISABLED':
      return layout('Two-step verification turned off', {
        heading: 'Two-step verification is off',
        paragraphs: [
          hi,
          'Two-step verification was disabled on your account.',
          ignore,
        ],
      });
    case 'ORDER_CONFIRMED':
      return layout(`Order ${oneLine(m.orderNumber)} confirmed`, {
        heading: 'Thank you for your order',
        paragraphs: [
          hi,
          `We received your payment of ${formatInr(m.totalMinor)} for order ${m.orderNumber}. We will let you know when it ships.`,
        ],
        cta: { label: 'View order', url: `${base}/account/orders` },
      });
    case 'PAYMENT_FAILED':
      return layout(`Payment failed for order ${oneLine(m.orderNumber)}`, {
        heading: 'Your payment did not go through',
        paragraphs: [
          hi,
          `The payment for order ${m.orderNumber} was not completed. Your items are held for a short time, so you can try again.`,
        ],
        cta: { label: 'Retry payment', url: `${base}/account/orders` },
      });
    case 'ORDER_SHIPPED':
      return layout(`Order ${oneLine(m.orderNumber)} has shipped`, {
        heading: 'Your order is on its way',
        paragraphs: [hi, `Order ${m.orderNumber} has been shipped.`],
        cta: { label: 'Track order', url: `${base}/account/orders` },
      });
    case 'ORDER_DELIVERED':
      return layout(`Order ${oneLine(m.orderNumber)} delivered`, {
        heading: 'Your order was delivered',
        paragraphs: [
          hi,
          `Order ${m.orderNumber} has been delivered. We hope you like it - you can leave a review from your orders page.`,
        ],
        cta: { label: 'View order', url: `${base}/account/orders` },
      });
    case 'ORDER_CANCELLED':
      return layout(`Order ${oneLine(m.orderNumber)} cancelled`, {
        heading: 'Your order was cancelled',
        paragraphs: [
          hi,
          `Order ${m.orderNumber} has been cancelled. If you had already paid, the refund is on its way to your original payment method.`,
        ],
      });
    case 'REFUND_PROCESSED':
      return layout(`Refund processed for order ${oneLine(m.orderNumber)}`, {
        heading: 'Your refund was processed',
        paragraphs: [
          hi,
          `We refunded ${formatInr(m.amountMinor)} for order ${m.orderNumber}. Depending on your bank or payment method it can take up to 10 working days to show.`,
        ],
      });
    case 'RETURN_UPDATE':
      return layout(`Return update for order ${oneLine(m.orderNumber)}`, {
        heading: 'Update on your return',
        paragraphs: [
          hi,
          `Your return request for order ${m.orderNumber} is now: ${oneLine(m.status).toLowerCase()}.`,
        ],
        cta: { label: 'View order', url: `${base}/account/orders` },
      });
    case 'CONTACT_MESSAGE':
      // Every value is customer-typed: layout() escapes paragraphs and the subject is one line.
      return layout(
        `Contact form: ${oneLine(m.topic)}${m.orderNumber ? ` (order ${oneLine(m.orderNumber)})` : ''}`,
        {
          heading: 'New message from the website',
          paragraphs: [
            `From: ${oneLine(m.fromName)} <${oneLine(m.fromEmail)}>`,
            `Topic: ${oneLine(m.topic)}`,
            ...(m.orderNumber ? [`Order: ${oneLine(m.orderNumber)}`] : []),
            m.message,
          ],
          footnote:
            'Reply to the customer from your own mailbox. Never ask for card numbers, passwords or one-time codes.',
        },
      );
    default: {
      const unreachable: never = m;
      throw new Error(`No template for ${JSON.stringify(unreachable)}`);
    }
  }
}
