import { randomBytes } from 'node:crypto';
import type { OutboundEmail } from '../ports/ports.js';

/**
 * A raw MIME message for an email with attachments (pure apart from the random boundary; unit-tested).
 * Header injection is impossible by construction: addresses with CR/LF are refused, the subject is RFC 2047 encoded
 * (base64, so no CR/LF survives), filenames must be plain [A-Za-z0-9._-], and every body part is base64.
 */
const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,100}$/;

const b64Lines = (text: string) =>
  (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? ['']
  ).join('\r\n');

function headerAddress(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Invalid email address');
  return value;
}

export function buildMimeMessage(
  from: string,
  email: OutboundEmail,
  boundarySeed: () => string = () => randomBytes(12).toString('hex'),
): string {
  const mixed = `mixed_${boundarySeed()}`;
  const alt = `alt_${boundarySeed()}`;
  const subject = `=?UTF-8?B?${Buffer.from(email.subject.replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${headerAddress(from)}`,
    `To: ${headerAddress(email.to)}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(email.text),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(email.html),
    `--${alt}--`,
  ];
  for (const a of email.attachments ?? []) {
    if (!SAFE_FILENAME.test(a.filename))
      throw new Error('Invalid attachment filename');
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; charset=UTF-8; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64Lines(a.content),
    );
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}
