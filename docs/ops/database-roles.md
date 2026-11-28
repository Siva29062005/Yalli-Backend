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

## Repair: append-only tables

The migrations revoke UPDATE/DELETE from `yalli_app` on the append-only tables only if the role exists when they run
(`IF EXISTS`). A role created later, or a broad `GRANT … ON ALL TABLES`, gives the rights back. The application checks its
own login at start-up (`DatabasePrivilegeCheck`, `src/infrastructure/database/privilege-check.ts`): **production refuses to
start** and names the rights it holds; other environments log a warning. Repair as `yalli_migrator`:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, consents, inventory_movements, order_status_history, payment_events,
  order_items, shipment_events, credit_notes, credit_note_lines FROM yalli_app;
REVOKE DELETE, TRUNCATE ON orders, payments, refunds, webhook_inbox, shipments, document_counters FROM yalli_app;
```

Create the three roles BEFORE the first `prisma migrate deploy`, and never `GRANT ALL` to `yalli_app`.
