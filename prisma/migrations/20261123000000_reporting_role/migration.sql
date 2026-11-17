-- Hand-written. Least-privilege role for the admin analytics reports.
-- The role (yalli_reporting) is created by infrastructure (docker init script / Terraform), like yalli_app; when it does not exist
-- yet this migration does nothing and the same grants must be applied once after creating it (docs/ops/database-roles.md).
--
-- COLUMN-level grants: the reporting connection can read the money/time/product columns the reports aggregate and NOTHING else.
-- It cannot read contact details, shipping addresses, password hashes, tokens, MFA secrets, the audit log or any other table,
-- and it has no INSERT/UPDATE/DELETE anywhere. A SQL-injection or a leaked reporting credential exposes aggregates, not customers.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yalli_reporting') THEN
    GRANT USAGE ON SCHEMA public TO "yalli_reporting";
    GRANT SELECT ("id", "user_id", "status", "subtotal_minor", "discount_minor", "shipping_minor", "gst_included_minor", "total_minor", "placed_at", "paid_at")
      ON "orders" TO "yalli_reporting";
    GRANT SELECT ("order_id", "product_id", "product_name", "quantity", "line_total_minor", "gst_rate_bps", "gst_included_minor", "cgst_minor", "sgst_minor", "igst_minor")
      ON "order_items" TO "yalli_reporting";
    GRANT SELECT ("status", "amount_minor", "processed_at")
      ON "refunds" TO "yalli_reporting";
  END IF;
END
$$;
