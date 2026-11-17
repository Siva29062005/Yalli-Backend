import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** `Algorithm` is a const enum (unusable under isolatedModules); Argon2id === 2 in the library. */
const ARGON2ID = 2 as Algorithm;

/** OWASP-aligned Argon2id baseline; stored in the hash string, so parameters can be raised later (rehash on login). */
const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;
const MAX_CONCURRENT = 4;
const MAX_QUEUE = 64;

@Injectable()
export class PasswordService {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private dummyHash: Promise<string> | undefined;

  /** Hashing is deliberately expensive, so bound concurrency: a login flood must not exhaust CPU/RAM. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) {
      if (this.queue.length >= MAX_QUEUE)
        throw new ServiceUnavailableException('Server busy');
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  hash(password: string): Promise<string> {
    return this.withSlot(() => hash(password, PARAMS));
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await this.withSlot(() => verify(storedHash, password));
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      return false; // malformed hash etc. => not a match
    }
  }

  /** Burn the same CPU as a real check when the account does not exist (no user-enumeration by timing). */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash('dummy-password-for-timing-equalisation', PARAMS);
    await this.verify(await this.dummyHash, password);
  }

  needsRehash(storedHash: string): boolean {
    const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!m) return true;
    return (
      Number(m[1]) < PARAMS.memoryCost ||
      Number(m[2]) < PARAMS.timeCost ||
      Number(m[3]) < PARAMS.parallelism
    );
  }
}
