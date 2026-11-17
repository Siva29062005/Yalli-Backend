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
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedMessage.create({ data: { consumer, messageId } });
        await work(tx);
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false; // already processed
      throw err;
    }
  }
}
