import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

const KEY_FORMAT = /^[A-Za-z0-9._:-]{8,128}$/;
const TTL_HOURS = 24;
const STALE_IN_PROGRESS_SECONDS = 120;

export const hashRequest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function assertIdempotencyKey(key: string | undefined): string {
  if (!key || !KEY_FORMAT.test(key)) {
    throw new BadRequestException({
      message:
        'An Idempotency-Key header (8-128 URL-safe characters) is required',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  }
  return key;
}

/**
 * Makes unsafe endpoints (checkout, payments, refunds) safe to retry. The same key + same request returns the ORIGINAL
 * response without doing the work again; the same key with a DIFFERENT request is refused; a concurrent duplicate gets 409.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    input: { scope: string; actorId: string; key: string; request: unknown },
    work: () => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    const requestHash = hashRequest(input.request);
    const where = {
      scope_actorId_key: {
        scope: input.scope,
        actorId: input.actorId,
        key: input.key,
      },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = await this.tryClaim(input, requestHash);
      if (claimed) {
        try {
          const result = await work();
          await this.prisma.idempotencyRecord.update({
            where,
            data: {
              status: 'COMPLETED',
              responseCode: result.status,
              responseBody: result.body as Prisma.InputJsonValue,
            },
          });
          return { ...result, replayed: false };
        } catch (err) {
          // A failed attempt must not poison the key: the client may retry with the same key.
          await this.prisma.idempotencyRecord.deleteMany({
            where: {
              scope: input.scope,
              actorId: input.actorId,
              key: input.key,
              status: 'IN_PROGRESS',
            },
          });
          throw err;
        }
      }
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where,
      });
      if (!existing) continue; // deleted between claim and read: try again
      if (existing.requestHash !== requestHash) {
        throw new HttpException(
          {
            message:
              'This Idempotency-Key was already used with a different request',
            code: 'IDEMPOTENCY_KEY_REUSED',
          },
          422,
        );
      }
      if (existing.status === 'COMPLETED')
        return {
          status: existing.responseCode ?? 200,
          body: existing.responseBody as T,
          replayed: true,
        };
      if (
        Date.now() - existing.createdAt.getTime() >
        STALE_IN_PROGRESS_SECONDS * 1000
      ) {
        await this.prisma.idempotencyRecord.deleteMany({
          where: { id: existing.id, status: 'IN_PROGRESS' },
        }); // abandoned by a crashed worker
        continue;
      }
      throw new ConflictException({
        message: 'A request with this Idempotency-Key is still being processed',
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
    }
    throw new ConflictException({
      message: 'Could not acquire the idempotency key; retry',
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  }

  private async tryClaim(
    input: { scope: string; actorId: string; key: string },
    requestHash: string,
  ): Promise<boolean> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          scope: input.scope,
          actorId: input.actorId,
          key: input.key,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + TTL_HOURS * 3_600_000),
        },
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false;
      throw err;
    }
  }

  /** Housekeeping. */
  async purgeExpired(): Promise<number> {
    return (
      await this.prisma.idempotencyRecord.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      })
    ).count;
  }
}
