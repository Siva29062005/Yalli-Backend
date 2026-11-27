-- GST on delivery fees (composite supply) and GST credit notes (CGST Act s.34).
-- Generated part first (prisma migrate diff), then HAND-WRITTEN constraints, triggers and grants: keep them when regenerating.

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "shipping_cgst_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_gst_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_igst_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_sgst_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_share_minor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "credit_note_number" VARCHAR(16) NOT NULL,
    "financial_year" CHAR(7) NOT NULL,
    "refund_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "invoice_number" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "supply" VARCHAR(12) NOT NULL,
    "place_of_supply" VARCHAR(60) NOT NULL,
    "taxable_value_minor" INTEGER NOT NULL,
    "cgst_minor" INTEGER NOT NULL,
    "sgst_minor" INTEGER NOT NULL,
    "igst_minor" INTEGER NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "order_item_id" UUID,
    "position" INTEGER NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "description" VARCHAR(250) NOT NULL,
    "hsn_code" VARCHAR(10),
    "gst_rate_bps" INTEGER NOT NULL,
    "taxable_value_minor" INTEGER NOT NULL,
    "cgst_minor" INTEGER NOT NULL,
    "sgst_minor" INTEGER NOT NULL,
    "igst_minor" INTEGER NOT NULL,
    "total_minor" INTEGER NOT NULL,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counters" (
    "name" VARCHAR(40) NOT NULL,
    "next_value" INTEGER NOT NULL,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_credit_note_number_key" ON "credit_notes"("credit_note_number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_refund_id_key" ON "credit_notes"("refund_id");

-- CreateIndex
CREATE INDEX "credit_notes_order_id_idx" ON "credit_notes"("order_id");

-- CreateIndex
CREATE INDEX "credit_notes_issued_at_idx" ON "credit_notes"("issued_at");

-- CreateIndex
CREATE INDEX "credit_note_lines_credit_note_id_idx" ON "credit_note_lines"("credit_note_id");

-- CreateIndex
CREATE INDEX "credit_note_lines_order_item_id_idx" ON "credit_note_lines"("order_item_id");

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ================================================= HAND-WRITTEN =================================================

-- ---- Delivery share on each order line: never negative, its GST within it, components add up -----------------
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_shipping_chk" CHECK (
    "shipping_share_minor" >= 0
    AND "shipping_gst_minor" >= 0 AND "shipping_gst_minor" <= "shipping_share_minor"
    AND "shipping_cgst_minor" >= 0 AND "shipping_sgst_minor" >= 0 AND "shipping_igst_minor" >= 0
    AND "shipping_cgst_minor" + "shipping_sgst_minor" + "shipping_igst_minor" = "shipping_gst_minor");

-- ---- Credit notes: consistent money, a valid supply type, and the right tax heads for it ----------------------
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_money_chk" CHECK (
    "total_minor" > 0 AND "taxable_value_minor" >= 0
    AND "cgst_minor" >= 0 AND "sgst_minor" >= 0 AND "igst_minor" >= 0
    AND "taxable_value_minor" + "cgst_minor" + "sgst_minor" + "igst_minor" = "total_minor"),
  ADD CONSTRAINT "credit_notes_supply_chk" CHECK (
    ("supply" = 'INTRA_STATE' AND "igst_minor" = 0)
    OR ("supply" = 'INTER_STATE' AND "cgst_minor" = 0 AND "sgst_minor" = 0)),
  ADD CONSTRAINT "credit_notes_fy_chk" CHECK ("financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
  ADD CONSTRAINT "credit_notes_number_chk" CHECK ("credit_note_number" ~ '^CN/[0-9]{4}/[0-9]{6,}$');

ALTER TABLE "credit_note_lines"
  ADD CONSTRAINT "credit_note_lines_money_chk" CHECK (
    "total_minor" > 0 AND "taxable_value_minor" >= 0
    AND "cgst_minor" >= 0 AND "sgst_minor" >= 0 AND "igst_minor" >= 0
    AND "taxable_value_minor" + "cgst_minor" + "sgst_minor" + "igst_minor" = "total_minor"),
  ADD CONSTRAINT "credit_note_lines_kind_chk" CHECK ("kind" IN ('GOODS', 'DELIVERY')),
  ADD CONSTRAINT "credit_note_lines_item_chk" CHECK ("kind" = 'DELIVERY' OR "order_item_id" IS NOT NULL),
  ADD CONSTRAINT "credit_note_lines_rate_chk" CHECK ("gst_rate_bps" BETWEEN 0 AND 4000),
  ADD CONSTRAINT "credit_note_lines_position_uq" UNIQUE ("credit_note_id", "position");

ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_next_chk" CHECK ("next_value" >= 1);

-- ---- Issued credit notes are statutory records: never edited or deleted (same function as the audit log) -------
CREATE TRIGGER "credit_notes_immutable"      BEFORE UPDATE OR DELETE ON "credit_notes"      FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "credit_note_lines_immutable" BEFORE UPDATE OR DELETE ON "credit_note_lines" FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "credit_notes", "credit_note_lines" FROM "yalli_app";
    REVOKE DELETE, TRUNCATE ON "document_counters" FROM "yalli_app";
  END IF;
END
$$;

-- ---- Reporting role: only the columns the GST summary aggregates ----------------------------------------------
GRANT SELECT ("shipping_share_minor", "shipping_gst_minor", "shipping_cgst_minor", "shipping_sgst_minor", "shipping_igst_minor")
  ON "order_items" TO "yalli_reporting";
GRANT SELECT ("id", "issued_at", "taxable_value_minor", "cgst_minor", "sgst_minor", "igst_minor", "total_minor")
  ON "credit_notes" TO "yalli_reporting";
GRANT SELECT ("credit_note_id", "gst_rate_bps", "taxable_value_minor", "cgst_minor", "sgst_minor", "igst_minor", "total_minor")
  ON "credit_note_lines" TO "yalli_reporting";
