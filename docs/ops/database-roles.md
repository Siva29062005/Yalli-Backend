# Database roles

| Role | Used by | Can |
|---|---|---|
| `yalli_migrator` | migration job only | DDL. Owns the schema. The app never receives its URL. |
| `yalli_app` | the API | SELECT/INSERT/UPDATE/DELETE on tables; no DDL; no UPDATE/DELETE on append-only ledgers (`audit_logs`, `order_status_history`, `payment_events`, `shipment_events`, `order_items`) |
| `yalli_reporting` | analytics only (`REPORTING_DATABASE_URL`) | column-level SELECT on the report columns of `orders`, `order_items`, `refunds`. Nothing else: no contact details, addresses, passwords, tokens, MFA secrets, audit log. Sessions are read-only. |

The migration `20261123000000_reporting_role` is **idempotent**: it ensures the `yalli_reporting` role exists and
(re)applies the column-level grants, so it can never silently skip them. For a database created before the role existed,
either re-run `prisma migrate deploy` (the migration is already recorded as applied, so re-apply the grants manually):

```sql
CREATE ROLE yalli_reporting LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE yalli TO yalli_reporting;
```
then copy the `GRANT SELECT (...)` statements from `prisma/migrations/20261123000000_reporting_role/migration.sql`
and run them as `yalli_migrator`.
Without `REPORTING_DATABASE_URL`, reports fall back to the app role (acceptable locally, not in production).

Verify: `./scripts/verify-docker.sh` (Phase 7 section) and `test/commerce/analytics.e2e-spec.ts`.
