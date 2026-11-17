# Database roles

| Role | Used by | Can |
|---|---|---|
| `yalli_migrator` | migration job only | DDL. Owns the schema. The app never receives its URL. |
| `yalli_app` | the API | SELECT/INSERT/UPDATE/DELETE on tables; no DDL; no UPDATE/DELETE on append-only ledgers (`audit_logs`, `order_status_history`, `payment_events`, `shipment_events`, `order_items`) |
| `yalli_reporting` | analytics only (`REPORTING_DATABASE_URL`) | column-level SELECT on the report columns of `orders`, `order_items`, `refunds`. Nothing else: no contact details, addresses, passwords, tokens, MFA secrets, audit log. Sessions are read-only. |

The migrations grant to `yalli_reporting` **only if the role already exists**. For a database created before the role existed:

```sql
CREATE ROLE yalli_reporting LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE yalli TO yalli_reporting;
```
then re-apply the grants (copy the `DO` block from `prisma/migrations/20261123000000_reporting_role/migration.sql` and run it as `yalli_migrator`).
Without `REPORTING_DATABASE_URL`, reports fall back to the app role (acceptable locally, not in production).

Verify: `./scripts/verify-docker.sh` (Phase 7 section) and `test/commerce/analytics.e2e-spec.ts`.
