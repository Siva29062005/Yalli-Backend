import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Next serial of a gapless document series (GST Rule 46 for invoices, s.34 for credit notes), e.g.
 * `invoice:2026-27`. Runs on the CALLER's transaction: the counter row stays locked until that transaction commits,
 * so concurrent documents queue up, and a rolled-back transaction gives its number back (no gaps).
 */
export async function takeSerial(
  tx: Prisma.TransactionClient,
  counter: string,
): Promise<number> {
  await tx.$executeRaw`INSERT INTO document_counters (name, next_value) VALUES (${counter}, 1) ON CONFLICT (name) DO NOTHING`;
  const [taken] = await tx.$queryRaw<{ n: number }[]>`
    UPDATE document_counters SET next_value = next_value + 1 WHERE name = ${counter} RETURNING (next_value - 1)::int AS n`;
  if (!taken) throw new Error(`document counter ${counter} unavailable`);
  return taken.n;
}
