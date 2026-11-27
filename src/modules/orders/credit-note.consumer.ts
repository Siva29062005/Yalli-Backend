import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessageBus, type EventEnvelope } from '../outbox/message-bus.js';
import { MessageDeduplicator } from '../outbox/run-once.js';
import { CreditNoteService } from './credit-note.service.js';

const CONSUMER = 'credit-notes';

/**
 * Issues the GST credit note when a refund is processed. Kept OUT of the refund transaction on purpose: a problem with
 * the tax document must never roll back or block the money state of a refund the provider has already paid. The note is
 * written in the same transaction as the dedupe record, so it is issued exactly once and retried if it fails.
 */
@Injectable()
export class CreditNoteConsumer implements OnModuleInit {
  private readonly logger = new Logger(CreditNoteConsumer.name);

  constructor(
    private readonly bus: MessageBus,
    private readonly dedupe: MessageDeduplicator,
    private readonly creditNotes: CreditNoteService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bus.subscribe(CONSUMER, ['refund.processed'], (e) =>
      this.handle(e),
    );
  }

  async handle(event: EventEnvelope): Promise<void> {
    const raw = event.payload['refundId'];
    if (typeof raw !== 'string') return;
    try {
      await this.dedupe.runOnce(CONSUMER, event.id, async (tx) => {
        await this.creditNotes.issueForRefundInTx(tx, raw);
      });
    } catch (err) {
      // No amounts or personal data in the log: the refund id is enough to investigate.
      this.logger.error(
        { refundId: raw, err: (err as Error).message },
        'credit note could not be issued; will retry',
      );
      throw err;
    }
  }
}
