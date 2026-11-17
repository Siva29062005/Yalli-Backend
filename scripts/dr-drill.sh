#!/usr/bin/env bash
# Disaster-recovery drill for the LOCAL compose stack: back up the live database, restore the backup into a scratch
# database, and prove the restored copy is complete and still obeys the money invariants. Reports the restore time (your
# measured RTO for this data size). Nothing is changed in the live database; the scratch database is always dropped.
#
#   docker compose up -d postgres      # (and have some data, e.g. after ./scripts/verify-docker.sh)
#   ./scripts/dr-drill.sh
#
# The production procedure (RDS snapshots + point-in-time recovery) is in docs/ops/backup-restore.md; this drill proves the
# logical backup and the integrity checks that you also run after a production restore.
set -uo pipefail
cd "$(dirname "$0")/.."

SCRATCH="yalli_drill_$$"
DUMP_DIR="$(mktemp -d)"
FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
step() { printf '\n== %s\n' "$1"; }
# Superuser inside the container (local socket). Used for dump/restore only, never by the application.
SU() { docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }
cleanup() { SU -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1; rm -rf "$DUMP_DIR"; }
trap cleanup EXIT

step "Pre-flight"
docker compose ps postgres --format '{{.State}}' 2>/dev/null | grep -q running || { echo "postgres is not running (docker compose up -d postgres)"; exit 2; }
[ "$(SU -d yalli -c "SELECT count(*) FROM information_schema.tables WHERE table_name='orders'")" = "1" ] || { echo "no yalli schema: run the migrations first"; exit 2; }
SRC_ORDERS=$(SU -d yalli -c "SELECT count(*) FROM orders")
pass "live database reachable ($SRC_ORDERS orders)"

step "Back up (custom-format logical dump, no passwords or roles inside)"
T0=$(date +%s)
docker compose exec -T postgres pg_dump -U postgres -d yalli -Fc --no-owner --no-privileges > "$DUMP_DIR/yalli.dump" || { fail "pg_dump failed"; exit 1; }
SIZE=$(wc -c < "$DUMP_DIR/yalli.dump" | tr -d ' ')
[ "$SIZE" -gt 1000 ] && pass "backup written ($SIZE bytes, $(( $(date +%s) - T0 ))s)" || { fail "backup is suspiciously small"; exit 1; }

step "Restore into a scratch database"
SU -d postgres -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null || { fail "cannot create scratch database"; exit 1; }
T1=$(date +%s)
docker compose exec -T postgres pg_restore -U postgres -d "$SCRATCH" --no-owner --no-privileges --exit-on-error < "$DUMP_DIR/yalli.dump" 2>"$DUMP_DIR/restore.log" \
  && pass "restore completed in $(( $(date +%s) - T1 ))s (measured restore time for this data size)" \
  || { fail "pg_restore failed: $(head -3 "$DUMP_DIR/restore.log")"; exit 1; }

step "Completeness: every table has exactly the live row count"
TABLES=$(SU -d yalli -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
BAD=0; N=0
for t in $TABLES; do
  a=$(SU -d yalli -c "SELECT count(*) FROM \"$t\""); b=$(SU -d "$SCRATCH" -c "SELECT count(*) FROM \"$t\"")
  N=$((N+1)); [ "$a" = "$b" ] || { fail "table $t: live=$a restored=$b"; BAD=1; }
done
[ "$BAD" = 0 ] && pass "$N tables match row for row"

step "Schema guarantees survived the restore"
for q in \
  "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace|constraints (CHECK/FK/unique)" \
  "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal|triggers (immutability guards)" \
  "SELECT count(*) FROM pg_indexes WHERE schemaname='public'|indexes (incl. partial unique indexes)" \
  "SELECT count(*) FROM _prisma_migrations|applied migrations recorded"; do
  sql="${q%%|*}"; label="${q##*|}"
  a=$(SU -d yalli -c "$sql"); b=$(SU -d "$SCRATCH" -c "$sql")
  [ "$a" = "$b" ] && pass "$label: $a" || fail "$label: live=$a restored=$b"
done

step "Money and stock invariants hold in the RESTORED data (run these after every real restore)"
check() { # description | sql returning a count of VIOLATIONS
  local d="${1%%|*}" sql="${1##*|}" n
  n=$(SU -d "$SCRATCH" -c "$sql")
  [ "$n" = "0" ] && pass "$d" || fail "$d: $n violation(s)"
}
check "order totals = subtotal - discount + shipping|SELECT count(*) FROM orders WHERE total_minor <> subtotal_minor - discount_minor + shipping_minor"
check "every PAID-or-later order has a payment time|SELECT count(*) FROM orders WHERE status IN ('PAID','PROCESSING','SHIPPED','DELIVERED') AND paid_at IS NULL"
check "refunded never exceeds captured|SELECT count(*) FROM payments WHERE refunded_minor > captured_minor"
check "captured never exceeds the amount asked|SELECT count(*) FROM payments WHERE captured_minor > amount_minor"
check "at most one live payment per order|SELECT count(*) FROM (SELECT order_id FROM payments WHERE status IN ('CREATED','PENDING','AUTHORIZED','CAPTURED','REFUND_PENDING','PARTIALLY_REFUNDED') GROUP BY order_id HAVING count(*) > 1) x"
check "no order item without its order|SELECT count(*) FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL"
check "no negative or over-reserved stock|SELECT count(*) FROM inventory WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand"
check "four-eyes holds on every refund|SELECT count(*) FROM refunds WHERE approved_by_id IS NOT NULL AND approved_by_id = requested_by_id"
check "ledger rows only ever grew (no gaps in order history)|SELECT count(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id=o.id)"

step "Result"
if [ "$FAILED" = 0 ]; then printf '\033[32mDR drill passed: the backup restores completely and the data is consistent.\033[0m\n'; else printf '\033[31mDR drill FAILED - see above.\033[0m\n'; fi
exit "$FAILED"
