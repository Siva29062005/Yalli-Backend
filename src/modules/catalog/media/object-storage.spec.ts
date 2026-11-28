import type { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import { S3Storage } from './object-storage.js';

const cfg = (extra: Record<string, unknown> = {}) =>
  ({
    get: (k: string) =>
      ({
        AWS_REGION: 'ap-south-1',
        S3_BUCKET: 'yalli-media',
        S3_PREFIX: 'media/',
        ...extra,
      })[k],
  }) as unknown as ConfigService<Env, true>;
const KEY = '0190a7c0-0000-7000-8000-000000000000.jpg';

describe('S3Storage', () => {
  it('writes encrypted, immutable objects under the prefix, never overwriting a key', async () => {
    const send = vi.fn().mockResolvedValue({});
    await new S3Storage(cfg(), { send } as Pick<S3Client, 'send'>).put(
      KEY,
      Buffer.from('img'),
      'image/jpeg',
    );
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> })
      .input;
    expect(input).toMatchObject({
      Bucket: 'yalli-media',
      Key: `media/${KEY}`,
      ContentType: 'image/jpeg',
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(input).not.toHaveProperty('ACL'); // the bucket stays private
  });
  it('uses the KMS key when one is configured', async () => {
    const send = vi.fn().mockResolvedValue({});
    await new S3Storage(
      cfg({ S3_KMS_KEY_ID: 'arn:aws:kms:ap-south-1:1:key/x' }),
      { send } as Pick<S3Client, 'send'>,
    ).put(KEY, Buffer.from('i'), 'image/jpeg');
    expect(
      (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'arn:aws:kms:ap-south-1:1:key/x',
    });
  });
  it('reads bytes back; a missing object is null; other errors are raised', async () => {
    const body = {
      transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    };
    const ok = new S3Storage(cfg(), {
      send: vi.fn().mockResolvedValue({ Body: body }),
    } as Pick<S3Client, 'send'>);
    expect(await ok.get(KEY)).toEqual(Buffer.from([1, 2, 3]));
    const missing = new S3Storage(cfg(), {
      send: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('x'), { name: 'NoSuchKey' }),
        ),
    } as Pick<S3Client, 'send'>);
    expect(await missing.get(KEY)).toBeNull();
    const denied = new S3Storage(cfg(), {
      send: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('x'), { name: 'AccessDenied' }),
        ),
    } as Pick<S3Client, 'send'>);
    await expect(denied.get(KEY)).rejects.toThrow();
  });
  it('refuses any key that is not a server-generated name (no traversal into the bucket)', async () => {
    const send = vi.fn();
    const s3 = new S3Storage(cfg(), { send } as Pick<S3Client, 'send'>);
    for (const bad of ['../x.jpg', 'a/b.jpg', `${KEY}/..`, 'x.svg'])
      await expect(s3.put(bad, Buffer.from('i'), 'image/jpeg')).rejects.toThrow(
        'Invalid storage key',
      );
    expect(send).not.toHaveBeenCalled();
  });
  it('a retried PUT that meets its own earlier, successful attempt counts as stored; another object does not', async () => {
    const bytes = Buffer.from('img');
    const sha = (await import('node:crypto'))
      .createHash('sha256')
      .update(bytes)
      .digest('base64');
    const conflict = Object.assign(new Error('pre'), {
      name: 'PreconditionFailed',
    });
    const ours = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ChecksumSHA256: sha });
    await expect(
      new S3Storage(cfg(), { send: ours } as Pick<S3Client, 'send'>).put(
        KEY,
        bytes,
        'image/jpeg',
      ),
    ).resolves.toBeUndefined();
    const theirs = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ChecksumSHA256: 'other' });
    await expect(
      new S3Storage(cfg(), { send: theirs } as Pick<S3Client, 'send'>).put(
        KEY,
        bytes,
        'image/jpeg',
      ),
    ).rejects.toThrow('pre');
  });
});
