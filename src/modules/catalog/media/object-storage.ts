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
