-- Hand-written (partial indexes cannot be expressed in the Prisma schema). Keep when regenerating.
-- Admin analytics filter paid orders and processed refunds by time; keep those reports index-driven as the shop grows.
CREATE INDEX "orders_paid_at_idx" ON "orders" ("paid_at") WHERE "paid_at" IS NOT NULL;
CREATE INDEX "refunds_processed_at_idx" ON "refunds" ("processed_at") WHERE "status" = 'PROCESSED';
