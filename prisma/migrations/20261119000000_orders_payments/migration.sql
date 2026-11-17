-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'INVENTORY_RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RefundKind" AS ENUM ('CUSTOMER_CANCEL', 'LATE_CAPTURE', 'RETURN', 'GOODWILL', 'ADMIN');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEAD_ON_ARRIVAL', 'FAULTY', 'ORDER_ERROR', 'WRONG_ITEM', 'OTHER');

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(20) NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "status_before_refund" "OrderStatus",
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "subtotal_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "shipping_minor" INTEGER NOT NULL DEFAULT 0,
    "gst_included_minor" INTEGER NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "coupon_id" UUID,
    "coupon_code" VARCHAR(40),
    "contact_email" VARCHAR(254) NOT NULL,
    "contact_phone" VARCHAR(20),
    "ship_name" VARCHAR(120) NOT NULL,
    "ship_phone" VARCHAR(20) NOT NULL,
    "ship_line1" VARCHAR(200) NOT NULL,
    "ship_line2" VARCHAR(200),
    "ship_landmark" VARCHAR(120),
    "ship_city" VARCHAR(80) NOT NULL,
    "ship_state" VARCHAR(60) NOT NULL,
    "ship_postal_code" VARCHAR(10) NOT NULL,
    "ship_country" CHAR(2) NOT NULL DEFAULT 'IN',
    "payment_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),
    "shipped_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(200),
    "inventory_released_at" TIMESTAMPTZ(6),
    "tracking_carrier" VARCHAR(60),
    "tracking_number" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "variant_name" VARCHAR(120),
    "image_key" VARCHAR(120),
    "hsn_code" VARCHAR(10),
    "unit_price_minor" INTEGER NOT NULL,
    "compare_at_minor" INTEGER,
    "quantity" INTEGER NOT NULL,
    "line_subtotal_minor" INTEGER NOT NULL,
    "line_discount_minor" INTEGER NOT NULL DEFAULT 0,
    "line_total_minor" INTEGER NOT NULL,
    "gst_rate_bps" INTEGER NOT NULL,
    "gst_included_minor" INTEGER NOT NULL,
    "cgst_minor" INTEGER NOT NULL DEFAULT 0,
    "sgst_minor" INTEGER NOT NULL DEFAULT 0,
    "igst_minor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "provider_order_id" VARCHAR(64),
    "provider_payment_id" VARCHAR(64),
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "captured_minor" INTEGER NOT NULL DEFAULT 0,
    "refunded_minor" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "method" VARCHAR(30),
    "failure_code" VARCHAR(80),
    "failure_reason" VARCHAR(300),
    "idempotency_key" VARCHAR(128),
    "initiating_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "captured_at" TIMESTAMPTZ(6),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "payment_id" UUID,
    "provider" VARCHAR(20) NOT NULL,
    "provider_event_id" VARCHAR(80),
    "type" VARCHAR(60) NOT NULL,
    "from_status" VARCHAR(30),
    "to_status" VARCHAR(30),
    "source" VARCHAR(20) NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_inbox" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "provider_event_id" VARCHAR(80) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "outcome" VARCHAR(40),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "return_request_id" UUID,
    "kind" "RefundKind" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_id" UUID,
    "approved_by_id" UUID,
    "rejection_reason" VARCHAR(200),
    "provider_refund_id" VARCHAR(64),
    "receipt" VARCHAR(40) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "failure_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "opened" BOOLEAN NOT NULL,
    "details" VARCHAR(1000),
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "decided_by_id" UUID,
    "decision_note" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_messages" (
    "consumer" VARCHAR(60) NOT NULL,
    "message_id" VARCHAR(64) NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_user_id_placed_at_idx" ON "orders"("user_id", "placed_at" DESC);

-- CreateIndex
CREATE INDEX "orders_status_payment_expires_at_idx" ON "orders"("status", "payment_expires_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_order_id_key" ON "payments"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_attempt_key" ON "payments"("order_id", "attempt");

-- CreateIndex
CREATE INDEX "payment_events_payment_id_created_at_idx" ON "payment_events"("payment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_inbox_provider_provider_event_id_key" ON "webhook_inbox"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_refund_id_key" ON "refunds"("provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_receipt_key" ON "refunds"("receipt");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at");

-- CreateIndex
CREATE INDEX "return_requests_order_id_idx" ON "return_requests"("order_id");

-- CreateIndex
CREATE INDEX "return_requests_user_id_created_at_idx" ON "return_requests"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written section (Prisma cannot express these). Keep when regenerating.
-- Financial invariants are enforced HERE as well as in the application.
-- ===========================================================================

-- Human-friendly, gap-tolerant order numbers: YL26-000123
CREATE SEQUENCE "order_number_seq" START 1000;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE "order_number_seq" TO "yalli_app";
  END IF;
END
$$;

-- ---- Orders: money is consistent and non-negative --------------------------------------------
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_money_chk" CHECK (
    "subtotal_minor" >= 0 AND "discount_minor" >= 0 AND "shipping_minor" >= 0 AND "gst_included_minor" >= 0 AND "total_minor" >= 0
    AND "discount_minor" <= "subtotal_minor"
    AND "total_minor" = "subtotal_minor" - "discount_minor" + "shipping_minor"
    AND "gst_included_minor" <= "total_minor"),
  ADD CONSTRAINT "orders_currency_chk" CHECK ("currency" = 'INR'),
  ADD CONSTRAINT "orders_paid_chk" CHECK ("status" NOT IN ('PAID','PROCESSING','SHIPPED','DELIVERED') OR "paid_at" IS NOT NULL),
  ADD CONSTRAINT "orders_cancelled_chk" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_money_chk" CHECK (
    "quantity" BETWEEN 1 AND 99 AND "unit_price_minor" > 0
    AND "line_subtotal_minor" = "unit_price_minor" * "quantity"
    AND "line_discount_minor" >= 0 AND "line_discount_minor" <= "line_subtotal_minor"
    AND "line_total_minor" = "line_subtotal_minor" - "line_discount_minor"
    AND "gst_included_minor" >= 0 AND "gst_included_minor" <= "line_total_minor"
    AND "cgst_minor" + "sgst_minor" + "igst_minor" = "gst_included_minor");

-- ---- Payments ----------------------------------------------------------------------------------
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_chk" CHECK ("amount_minor" > 0 AND "currency" = 'INR'),
  -- Captured money can never exceed what was asked for; refunded (incl. in-flight) never exceeds what was captured.
  ADD CONSTRAINT "payments_captured_chk" CHECK ("captured_minor" >= 0 AND "captured_minor" <= "amount_minor"),
  ADD CONSTRAINT "payments_refunded_chk" CHECK ("refunded_minor" >= 0 AND "refunded_minor" <= "captured_minor"),
  ADD CONSTRAINT "payments_attempt_chk" CHECK ("attempt" >= 1);

-- At most ONE live payment per order: a second charge for the same order is structurally impossible.
CREATE UNIQUE INDEX "payments_one_live_per_order_uniq" ON "payments" ("order_id")
  WHERE "status" IN ('CREATED','PENDING','AUTHORIZED','CAPTURED','REFUND_PENDING','PARTIALLY_REFUNDED');

-- ---- Refunds -----------------------------------------------------------------------------------
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_chk" CHECK ("amount_minor" > 0),
  -- A refund must be approved by someone other than whoever requested it (four-eyes).
  ADD CONSTRAINT "refunds_four_eyes_chk" CHECK ("approved_by_id" IS NULL OR "requested_by_id" IS NULL OR "approved_by_id" <> "requested_by_id");

-- ---- Returns -----------------------------------------------------------------------------------
ALTER TABLE "return_requests" ADD CONSTRAINT "return_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 99);
-- One open return per ORDER (the order moves through a single return state at a time).
CREATE UNIQUE INDEX "return_requests_one_open_uniq" ON "return_requests" ("order_id") WHERE "status" IN ('REQUESTED','APPROVED','RECEIVED');

-- ---- Immutable ledgers (same trigger function as audit_logs) --------------------------------
CREATE TRIGGER "order_status_history_immutable" BEFORE UPDATE OR DELETE ON "order_status_history" FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "payment_events_immutable"       BEFORE UPDATE OR DELETE ON "payment_events"       FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
-- Order snapshots (what was bought, at what price) never change after creation.
CREATE FUNCTION "forbid_order_item_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_items are immutable snapshots' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "order_items_immutable" BEFORE UPDATE OR DELETE ON "order_items" FOR EACH ROW EXECUTE FUNCTION "forbid_order_item_update"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "order_status_history", "payment_events", "order_items" FROM "yalli_app";
    REVOKE DELETE, TRUNCATE ON "orders", "payments", "refunds", "webhook_inbox" FROM "yalli_app";
  END IF;
END
$$;
