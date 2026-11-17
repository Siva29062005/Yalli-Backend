-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED_TO_SELLER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "shipping_method_code" VARCHAR(30),
ADD COLUMN     "shipping_method_name" VARCHAR(80);

-- CreateTable
CREATE TABLE "shipping_methods" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200),
    "base_minor" INTEGER NOT NULL,
    "free_above_minor" INTEGER,
    "eta_min_days" INTEGER NOT NULL,
    "eta_max_days" INTEGER NOT NULL,
    "states" TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipping_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "carrier" VARCHAR(60) NOT NULL,
    "tracking_number" VARCHAR(80) NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "shipped_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "location" VARCHAR(120),
    "note" VARCHAR(200),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_methods_code_key" ON "shipping_methods"("code");

-- CreateIndex
CREATE INDEX "shipping_methods_is_active_sort_order_idx" ON "shipping_methods"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_order_id_key" ON "shipments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_carrier_tracking_number_key" ON "shipments"("carrier", "tracking_number");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_occurred_at_idx" ON "shipment_events"("shipment_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written section (Prisma cannot express these). Keep when regenerating.
-- ===========================================================================

ALTER TABLE "shipping_methods"
  ADD CONSTRAINT "shipping_methods_code_chk" CHECK ("code" ~ '^[A-Z0-9_]{2,30}$'),
  ADD CONSTRAINT "shipping_methods_money_chk" CHECK (
    "base_minor" BETWEEN 0 AND 100000000
    AND ("free_above_minor" IS NULL OR "free_above_minor" > 0)),
  ADD CONSTRAINT "shipping_methods_eta_chk" CHECK ("eta_min_days" >= 0 AND "eta_max_days" >= "eta_min_days" AND "eta_max_days" <= 90);

-- An order's shipping snapshot is all-or-nothing, and shipping can only be charged when a method was recorded.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_shipping_method_chk" CHECK (
    ("shipping_method_code" IS NULL) = ("shipping_method_name" IS NULL)
    AND ("shipping_method_code" IS NOT NULL OR "shipping_minor" = 0));

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_delivered_chk" CHECK (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL));

-- Tracking history is append-only (same trigger function as the other ledgers).
CREATE TRIGGER "shipment_events_immutable" BEFORE UPDATE OR DELETE ON "shipment_events" FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "shipment_events" FROM "yalli_app";
    REVOKE DELETE, TRUNCATE ON "shipments" FROM "yalli_app";
  END IF;
END
$$;
