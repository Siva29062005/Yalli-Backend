import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Idempotent consumption: records (consumer, messageId) in the SAME transaction as the handler's effects, so a redelivered
 * message is skipped and a failed handler leaves no trace (it is retried). Returns false for a duplicate.
 */
@Injectable()
export class MessageDeduplicator {
  constructor(private readonly prisma: PrismaService) {}

  async runOnce(
    consumer: string,
    messageId: string,
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // INSERT … ON CONFLICT DO NOTHING: a duplicate is detected by the marker row alone. (Catching P2002 around the
      // whole transaction also swallowed unique violations raised by the WORK, acknowledging a message that failed.)
      // A concurrent copy of the same message waits on this row and then sees count 0.
      const { count } = await tx.processedMessage.createMany({
        data: [{ consumer, messageId }],
        skipDuplicates: true,
      });
      if (count === 0) return false; // already processed
      await work(tx);
      return true;
    });
  }
}
