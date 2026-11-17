import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import type {
  TokenPurpose,
  VerificationToken,
} from '../../../generated/prisma/client.js';
import {
  generateNumericCode,
  generateToken,
  safeEqual,
  sha256Hex,
} from '../crypto/token-utils.js';
import { addMinutes } from './identity-utils.js';

const OTP_MAX_ATTEMPTS = 5;

/**
 * Single-use, expiring, hashed tokens (email verification, password reset) and short numeric OTPs (phone).
 * Raw values are returned once to be delivered to the user; only hashes are stored.
 */
@Injectable()
export class VerificationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issues a link token. Any earlier unused token for the same user+purpose is invalidated. */
  async issueToken(
    userId: string,
    purpose: TokenPurpose,
    target: string,
    ttlMinutes: number,
  ): Promise<string> {
    const raw = generateToken();
    await this.invalidateOutstanding(userId, purpose);
    await this.prisma.verificationToken.create({
      data: {
        userId,
        purpose,
        target,
        tokenHash: sha256Hex(raw),
        expiresAt: addMinutes(new Date(), ttlMinutes),
      },
    });
    return raw;
  }

  /** Read-only check used before a state change that must not burn the token on a validation failure. */
  async peekToken(
    raw: string,
    purpose: TokenPurpose,
  ): Promise<VerificationToken | null> {
    const row = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: sha256Hex(raw) },
    });
    if (
      !row ||
      row.purpose !== purpose ||
      row.usedAt ||
      row.expiresAt <= new Date()
    )
      return null;
    return row;
  }

  /** Atomically consumes a token: exactly one caller can ever win (single use even under concurrency). */
  async consumeToken(
    raw: string,
    purpose: TokenPurpose,
  ): Promise<VerificationToken | null> {
    const row = await this.peekToken(raw, purpose);
    if (!row) return null;
    const res = await this.prisma.verificationToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    return res.count === 1 ? row : null;
  }

  async issueOtp(
    userId: string,
    purpose: TokenPurpose,
    target: string,
    ttlMinutes: number,
  ): Promise<string> {
    const code = generateNumericCode(6);
    const id = randomUUID();
    await this.invalidateOutstanding(userId, purpose);
    // The row id is part of the hash input so identical codes never collide on the unique hash column.
    await this.prisma.verificationToken.create({
      data: {
        id,
        userId,
        purpose,
        target,
        tokenHash: sha256Hex(`${id}:${code}`),
        expiresAt: addMinutes(new Date(), ttlMinutes),
      },
    });
    return code;
  }

  /** Attempt-limited OTP check. Returns the matched row's target on success. */
  async verifyOtp(
    userId: string,
    purpose: TokenPurpose,
    code: string,
  ): Promise<{ target: string } | null> {
    const row = await this.prisma.verificationToken.findFirst({
      where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    const bump = await this.prisma.verificationToken.updateMany({
      where: { id: row.id, attempts: { lt: OTP_MAX_ATTEMPTS }, usedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (bump.count !== 1) return null; // attempts exhausted: the code is dead, request a new one
    if (!safeEqual(sha256Hex(`${row.id}:${code}`), row.tokenHash)) return null;
    const used = await this.prisma.verificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return used.count === 1 ? { target: row.target } : null;
  }

  private async invalidateOutstanding(
    userId: string,
    purpose: TokenPurpose,
  ): Promise<void> {
    await this.prisma.verificationToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
