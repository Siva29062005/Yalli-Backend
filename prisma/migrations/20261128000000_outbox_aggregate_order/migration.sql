-- Hand-written (keep when regenerating): the outbox relay publishes only the OLDEST unpublished event of each aggregate,
-- so a failed event holds back the later events of the same aggregate (per-aggregate ordering) and nothing else.
CREATE INDEX "outbox_events_unpublished_aggregate_idx"
  ON "outbox_events" ("aggregate_type", "aggregate_id", "created_at", "id")
  WHERE "published_at" IS NULL;
