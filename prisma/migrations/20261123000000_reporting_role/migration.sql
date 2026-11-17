-- Hand-written. Least-privilege role for the admin analytics reports.
-- The role (yalli_reporting) is also created by infrastructure (docker init script / Terraform), like yalli_app. This migration is
-- idempotent: it ensures the role exists and (re)applies the grants, so it can never silently skip them if the role was not yet created.
-- COLUMN-level grants: the reporting connection can read the money/time/product columns the reports aggregate and NOTHING else.
-- It cannot read contact details, shipping addresses, password hashes, tokens, MFA secrets, the audit log or any other table,
-- and it has no INSERT/UPDATE/DELETE anywhere. A SQL-injection or a leaked reporting credential exposes aggregates, not customers.
-- Ensure the role exists (idempotent). The role's LOGIN password is owned by infrastructure
-- (docker init script / Terraform / secrets manager), so here we only guarantee the role object
-- and its password is set there — never hard-coded in a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_reporting') THEN
    CREATE ROLE "yalli_reporting" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  -- CONNECT comes from infra (01-roles.sh / Terraform) because it needs the database name;
  -- still, keep the role able to connect if this migration runs on a database where infra
  -- has not yet granted it (belt-and-suspenders, idempotent).
  GRANT CONNECT ON DATABASE yalli TO "yalli_reporting";
END
$$;

-- Grants are unconditional and idempotent: they either apply or the migration fails loudly,
-- never silently skip as a role-existence check can.
GRANT USAGE ON SCHEMA public TO "yalli_reporting";
GRANT SELECT ("id", "user_id", "status", "subtotal_minor", "discount_minor", "shipping_minor", "gst_included_minor", "total_minor", "placed_at", "paid_at")
  ON "orders" TO "yalli_reporting";
GRANT SELECT ("order_id", "product_id", "product_name", "quantity", "line_total_minor", "gst_rate_bps", "gst_included_minor", "cgst_minor", "sgst_minor", "igst_minor")
  ON "order_items" TO "yalli_reporting";
GRANT SELECT ("status", "amount_minor", "processed_at")
  ON "refunds" TO "yalli_reporting";
