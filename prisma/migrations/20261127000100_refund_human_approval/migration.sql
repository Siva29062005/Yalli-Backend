-- Hand-written: four-eyes for every refund a PERSON asked for. refunds_four_eyes_chk already forbids self-approval;
-- this also forbids a person-requested refund from reaching APPROVED/PROCESSING/PROCESSED/FAILED with no approver
-- (an auto-approved refund must be raised by the system: requested_by_id NULL). Backs the check in
-- RefundService.requestInTx and the staff-cancel path in OrderService.cancel.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_human_approval_chk"
  CHECK ("requested_by_id" IS NULL OR "status" IN ('PENDING_APPROVAL', 'REJECTED') OR "approved_by_id" IS NOT NULL);
