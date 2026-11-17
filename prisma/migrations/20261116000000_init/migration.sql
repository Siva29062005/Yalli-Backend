-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_type" VARCHAR(32) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "resource_type" VARCHAR(64),
    "resource_id" VARCHAR(128),
    "outcome" VARCHAR(16) NOT NULL,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "correlation_id" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "correlation_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(100) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "actor_id" UUID NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "response_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_occurred_at_idx" ON "audit_logs"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_created_at_idx" ON "outbox_events"("created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_actor_id_key_key" ON "idempotency_records"("scope", "actor_id", "key");


-- ===========================================================================
-- Hand-written section (Prisma cannot express these). Keep when regenerating.
-- ===========================================================================

-- Relay worker scans only unpublished events.
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("created_at") WHERE "published_at" IS NULL;

-- Domain CHECK constraints (defence in depth: never rely on ORM validation alone).
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_outcome_chk" CHECK ("outcome" IN ('SUCCESS', 'FAILURE', 'DENIED'));
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempts_chk" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "outbox_events_version_chk" CHECK ("event_version" >= 1);
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_status_chk" CHECK ("status" IN ('IN_PROGRESS', 'COMPLETED'));

-- Append-only enforcement for the audit trail (application level + DB level).
CREATE FUNCTION "forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_mutation"();

-- The runtime role (created by infra/docker/postgres/init) can only INSERT/SELECT audit rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM "yalli_app";
  END IF;
END
$$;
