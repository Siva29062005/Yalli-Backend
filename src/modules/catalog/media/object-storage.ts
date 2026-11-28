import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Env } from '../../../config/env.js';

/** Storage port. Production uses an object store (S3/CloudFront) behind the same interface. */
export abstract class ObjectStorage {
  abstract put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  abstract get(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
}

/** Keys are ALWAYS server-generated: "<uuid>.<ext>". Anything else is rejected (no path traversal is expressible). */
export const STORAGE_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** Development only (production env validation refuses it). */
@Injectable()
export class LocalDiskStorage extends ObjectStorage {
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.root = resolve(config.get('UPLOADS_DIR', { infer: true }));
  }

  private path(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error('Invalid storage key');
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep))
      throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.path(key), bytes, { flag: 'wx', mode: 0o640 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/**
 * Amazon S3 (production). Credentials come from the default AWS provider chain (the ECS task role): there is no access
 * key in the configuration. The bucket stays PRIVATE (block public access); images reach browsers through the media
 * route or CloudFront with origin access control, never from a public bucket.
 *  - every object is encrypted at rest (SSE-S3 unless S3_KMS_KEY_ID is set) and immutable by key (`If-None-Match: *`:
 *    an existing key is never overwritten, like the local driver's exclusive create);
 *  - keys are validated exactly as on disk (server-generated "<uuid>.<ext>" only), under an optional prefix.
 * Not verified against a live bucket yet (Phase 13 staging).
 */
@Injectable()
export class S3Storage extends ObjectStorage {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly kmsKeyId: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    private readonly client: Pick<S3Client, 'send'> = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 15_000 },
    }),
  ) {
    super();
    this.bucket = config.get('S3_BUCKET', { infer: true }) ?? '';
    this.prefix = config.get('S3_PREFIX', { infer: true }) ?? '';
    this.kmsKeyId = config.get('S3_KMS_KEY_ID', { infer: true });
  }

  private key(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error('Invalid storage key');
    return `${this.prefix}${key}`;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const sha256 = createHash('sha256').update(bytes).digest('base64');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.length,
          ChecksumSHA256: sha256,
          CacheControl: 'public, max-age=31536000, immutable',
          IfNoneMatch: '*',
          ...(this.kmsKeyId
            ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId }
            : { ServerSideEncryption: 'AES256' }),
        }),
      );
    } catch (err) {
      // The SDK retries a PUT whose answer was lost; if the first attempt WAS stored, the retry meets our own object
      // (412). Keys are fresh UUIDs, so an object with exactly these bytes there is our upload: success.
      const name = (err as { name?: string }).name;
      if (
        name !== 'PreconditionFailed' &&
        name !== 'ConditionalRequestConflict'
      )
        throw err;
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          ChecksumMode: 'ENABLED',
        }),
      );
      if (head.ChecksumSHA256 !== sha256) throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return out.Body
        ? Buffer.from(await out.Body.transformToByteArray())
        : null;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
  }
}
