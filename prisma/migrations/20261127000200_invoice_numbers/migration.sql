-- GST tax invoice numbers (Rule 46): consecutive and unique within the Indian financial year, at most 16 characters.
-- Taken from document_counters ('invoice:<YYYY-YY>') in the same transaction that marks the order PAID
-- (PaymentService), so unpaid and cancelled orders never consume a number. Previously the invoice number was
-- "INV-" + the order number, which has gaps and used the calendar year.

-- AlterTable (generated shape)
ALTER TABLE "orders" ADD COLUMN "invoice_number" VARCHAR(16);

-- CreateIndex (generated shape)
CREATE UNIQUE INDEX "orders_invoice_number_key" ON "orders"("invoice_number");

-- ---- Hand-written below: keep when regenerating ------------------------------------------------------------------

-- Number orders that were already paid, in payment order, per financial year (India time).
WITH fy AS (
  SELECT "id", "paid_at",
         (CASE WHEN EXTRACT(MONTH FROM "paid_at" AT TIME ZONE 'Asia/Kolkata') >= 4
               THEN EXTRACT(YEAR FROM "paid_at" AT TIME ZONE 'Asia/Kolkata')
               ELSE EXTRACT(YEAR FROM "paid_at" AT TIME ZONE 'Asia/Kolkata') - 1 END)::int AS "start"
  FROM "orders" WHERE "paid_at" IS NOT NULL AND "invoice_number" IS NULL
), numbered AS (
  SELECT "id", "start", row_number() OVER (PARTITION BY "start" ORDER BY "paid_at", "id") AS "n" FROM fy
)
UPDATE "orders" o
SET "invoice_number" = 'INV/' || lpad((n."start" % 100)::text, 2, '0') || lpad(((n."start" + 1) % 100)::text, 2, '0')
                       || '/' || lpad(n."n"::text, 6, '0')
FROM numbered n WHERE o."id" = n."id";

-- Counters continue after the numbers just assigned (label = financialYear().label, e.g. 2026-27).
INSERT INTO "document_counters" ("name", "next_value")
SELECT 'invoice:' || s."start" || '-' || lpad(((s."start" + 1) % 100)::text, 2, '0'), count(*) + 1
FROM (
  SELECT (CASE WHEN EXTRACT(MONTH FROM "paid_at" AT TIME ZONE 'Asia/Kolkata') >= 4
               THEN EXTRACT(YEAR FROM "paid_at" AT TIME ZONE 'Asia/Kolkata')
               ELSE EXTRACT(YEAR FROM "paid_at" AT TIME ZONE 'Asia/Kolkata') - 1 END)::int AS "start"
  FROM "orders" WHERE "invoice_number" IS NOT NULL
) s
GROUP BY s."start"
ON CONFLICT ("name") DO UPDATE SET "next_value" = GREATEST("document_counters"."next_value", EXCLUDED."next_value");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_invoice_number_chk" CHECK ("invoice_number" IS NULL OR "invoice_number" ~ '^INV/[0-9]{4}/[0-9]{6,7}$'),
  -- Every paid order has an invoice number and no unpaid order has one.
  ADD CONSTRAINT "orders_invoice_paid_chk" CHECK (("invoice_number" IS NULL) = ("paid_at" IS NULL));

-- Reporting (GST return preparation) may read the invoice number.
GRANT SELECT ("invoice_number") ON "orders" TO "yalli_reporting";
