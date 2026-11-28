-- The outbox relay orders events by created_at. Prisma filled it in from each process's clock (API and worker both write
-- events), so clock skew could invert two events of one aggregate. The database sets it now, at the insert:
-- clock_timestamp() (not now(), which is the transaction START), so for one aggregate it follows the order in which the
-- business transactions took that aggregate's row lock.
ALTER TABLE "outbox_events" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
