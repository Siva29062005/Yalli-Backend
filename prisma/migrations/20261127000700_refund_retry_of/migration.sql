-- Phase 11: retrying a FAILED refund raises a NEW refund request (four-eyes as usual) that points at the failed one.
-- UNIQUE: a failed refund can be retried once (a failed retry is retried by retrying IT, which keeps a clean chain).
ALTER TABLE "refunds" ADD COLUMN "retry_of_id" UUID;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_retry_of_id_key" UNIQUE ("retry_of_id");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_retry_of_id_fkey"
  FOREIGN KEY ("retry_of_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A refund cannot be a retry of itself.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_retry_not_self_chk" CHECK ("retry_of_id" IS NULL OR "retry_of_id" <> "id");
