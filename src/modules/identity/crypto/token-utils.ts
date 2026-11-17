import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit opaque secret, URL-safe. Used for refresh / reset / verification tokens. */
export const generateToken = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');

/** Fast hash is correct for HIGH-entropy secrets (never for passwords). */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Uniformly random 6-digit code (rejection sampling avoids modulo bias). */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < limit) return String(n % max).padStart(digits, '0');
  }
}

/** Human-friendly recovery code, 80 bits of entropy: XXXX-XXXX-XXXX-XXXX (Crockford-ish alphabet, no ambiguous chars). */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}
export const normalizeRecoveryCode = (code: string): string =>
  code.replace(/[\s-]/g, '').toUpperCase();
