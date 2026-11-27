-- One capture attempt at a time per payment (PaymentService.captureIfAuthorized claims it with a conditional UPDATE;
-- a claim older than 2 minutes is stale and may be retried by reconciliation). Prevents capturing a second
-- authorization on the same provider order after a capture call that timed out but succeeded.

-- AlterTable (generated shape)
ALTER TABLE "payments" ADD COLUMN "capture_started_at" TIMESTAMPTZ(6);
