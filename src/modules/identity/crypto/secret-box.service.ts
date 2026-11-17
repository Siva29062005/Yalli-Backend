import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../../../config/env.js';

/**
 * AES-256-GCM authenticated encryption for secrets at rest (TOTP seeds).
 * The AAD binds a ciphertext to its owner so it cannot be copied onto another account's row.
 * Format: "<keyId>.<iv>.<ciphertext>.<tag>" (base64url). In production the key comes from the secrets manager / KMS.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;
  private readonly keyId: string;
  /** Retired keys decrypt only; nothing is ever encrypted under them. */
  private readonly retired = new Map<string, Buffer>();

  constructor(config: ConfigService<Env, true>) {
    this.key = Buffer.from(
      config.get('MFA_ENCRYPTION_KEY_B64', { infer: true }),
      'base64',
    );
    this.keyId = config.get('MFA_ENCRYPTION_KEY_ID', { infer: true });
    const retired = JSON.parse(
      config.get('MFA_RETIRED_KEYS_JSON', { infer: true }) ?? '{}',
    ) as Record<string, string>;
    for (const [id, key] of Object.entries(retired))
      this.retired.set(id, Buffer.from(key, 'base64'));
  }

  /** True when the payload is already encrypted under the CURRENT key. */
  isCurrent(payload: string): boolean {
    return payload.startsWith(`${this.keyId}.`);
  }

  /** Decrypts under whichever known key sealed it and seals it again under the current key. */
  reencrypt(payload: string, aad: string): string {
    return this.encrypt(this.decrypt(payload, aad), aad);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      this.keyId,
      iv.toString('base64url'),
      ct.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, aad: string): string {
    const [keyId, iv, ct, tag] = payload.split('.');
    if (!keyId || !iv || !ct || !tag) throw new Error('Malformed ciphertext');
    const key = keyId === this.keyId ? this.key : this.retired.get(keyId);
    if (!key) throw new Error('Unknown encryption key id');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
