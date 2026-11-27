-- Hand-written. Phase 11 audit-log viewer (audit.read): it reads through the read-only reporting role.
-- COLUMN-level, like every reporting grant: the viewer gets what a security review needs, NOT the user agent string.
-- The reporting role still has no INSERT/UPDATE/DELETE anywhere (and the app role still cannot UPDATE/DELETE audit_logs).
GRANT SELECT ("id", "occurred_at", "actor_id", "actor_type", "action", "resource_type", "resource_id", "outcome", "ip", "correlation_id", "metadata")
  ON "audit_logs" TO "yalli_reporting";
