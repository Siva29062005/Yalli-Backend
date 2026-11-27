-- Contact form messages (POST /contact: public, rate-limited, captcha-checked, plain text). Staff read them in the admin.

-- CreateEnum (generated shape)
CREATE TYPE "ContactTopic" AS ENUM ('ORDER', 'RETURN', 'PAYMENT', 'ACCOUNT', 'PRODUCT', 'OTHER');

-- CreateEnum (generated shape)
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'HANDLED');

-- CreateTable (generated shape)
CREATE TABLE "contact_messages" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "order_number" VARCHAR(20),
    "topic" "ContactTopic" NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled_at" TIMESTAMPTZ(6),

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (generated shape)
CREATE INDEX "contact_messages_status_created_at_idx" ON "contact_messages"("status", "created_at" DESC);

-- ---- Hand-written below: keep when regenerating ------------------------------------------------------------------
ALTER TABLE "contact_messages"
  ADD CONSTRAINT "contact_messages_text_chk" CHECK (length(btrim("name")) > 0 AND length("message") >= 10 AND position('@' IN "email") > 1),
  ADD CONSTRAINT "contact_messages_handled_chk" CHECK (("status" = 'HANDLED') = ("handled_at" IS NOT NULL));
