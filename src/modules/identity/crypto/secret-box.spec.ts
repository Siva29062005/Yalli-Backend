import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../config/env.js';
import { SecretBox } from './secret-box.service.js';

const b64 = () => randomBytes(32).toString('base64');
const box = (id: string, key: string, retired: Record<string, string> = {}) =>
  new SecretBox({
    get: (k: string) =>
      ({
        MFA_ENCRYPTION_KEY_B64: key,
        MFA_ENCRYPTION_KEY_ID: id,
        MFA_RETIRED_KEYS_JSON: JSON.stringify(retired),
      })[k],
  } as unknown as ConfigService<Env, true>);

describe('SecretBox', () => {
  const kA = b64();
  const kB = b64();

  it('round-trips and binds the ciphertext to its owner', () => {
    const a = box('k1', kA);
    const ct = a.encrypt('JBSWY3DPEHPK3PXP', 'mfa:user-1');
    expect(ct.startsWith('k1.')).toBe(true);
    expect(a.decrypt(ct, 'mfa:user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => a.decrypt(ct, 'mfa:user-2')).toThrow(); // cannot be moved to another account
  });

  it('after a rotation the new key encrypts, the retired key still decrypts old data', () => {
    const old = box('k1', kA).encrypt('secret', 'mfa:u');
    const rotated = box('k2', kB, { k1: kA });
    expect(rotated.isCurrent(old)).toBe(false);
    expect(rotated.decrypt(old, 'mfa:u')).toBe('secret'); // nobody is locked out mid-rotation
    const fresh = rotated.reencrypt(old, 'mfa:u');
    expect(rotated.isCurrent(fresh)).toBe(true);
    expect(fresh.startsWith('k2.')).toBe(true);
    expect(rotated.decrypt(fresh, 'mfa:u')).toBe('secret');
    // once the retired key is dropped, only re-encrypted data remains readable
    const dropped = box('k2', kB);
    expect(dropped.decrypt(fresh, 'mfa:u')).toBe('secret');
    expect(() => dropped.decrypt(old, 'mfa:u')).toThrow(
      'Unknown encryption key id',
    );
  });

  it('rejects tampering, the wrong key and malformed input', () => {
    const a = box('k1', kA);
    const ct = a.encrypt('secret', 'mfa:u');
    const [id, iv, body, tag] = ct.split('.');
    expect(() =>
      a.decrypt([id, iv, `${body!.slice(0, -2)}AA`, tag].join('.'), 'mfa:u'),
    ).toThrow();
    expect(() => box('k1', kB).decrypt(ct, 'mfa:u')).toThrow(); // right id, wrong key material
    expect(() => a.decrypt('garbage', 'mfa:u')).toThrow('Malformed ciphertext');
  });
});
