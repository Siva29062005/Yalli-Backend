#!/usr/bin/env bash
# End-to-end check of the Docker setup: infra up, roles created, migration applied,
# app image builds, app boots, health + security headers respond. Safe to re-run.
# Usage: ./scripts/verify-docker.sh [--down]   (--down removes containers AND volumes afterwards)
set -uo pipefail
cd "$(dirname "$0")/.."

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0
step() { printf '\n== %s\n' "$1"; }
abort() { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }
# expect_denied "<description>" "<sql>" "<regex the error must match>" [psql-prefix]
# A failure for the WRONG reason is a FAIL. The probe must be CAPTURED before grepping:
# under `set -o pipefail` a pipeline like "psql | grep" is tainted by psql's *expected*
# non-zero exit, and grep -q on a long stream can SIGPIPE the producer - both yield false FAILs.
expect_denied() {
  local prefix="${4:-$APP}" out
  out=$( $prefix -c "$2" 2>&1 ) && { fail "$1: statement unexpectedly succeeded"; return; }
  grep -Eqi "$3" <<< "$out" && pass "$1" || fail "$1: failed for an unexpected reason: $out"
}

step "Docker"
docker --version && docker compose version || { echo "docker CLI not available"; exit 2; }
docker info >/dev/null 2>&1 && pass "daemon reachable" || { fail "daemon not reachable (start Docker Desktop)"; exit 2; }

step "Environment"
# Idempotent: creates .env, or adds only the variables that are missing (never overwrites existing values).
./scripts/setup-dev-env.sh
[ -f .env ] && pass ".env present" || { fail ".env missing"; exit 2; }
set -a; . ./.env; set +a

step "Compose config is valid"
docker compose config -q && pass "docker-compose.yml parses with .env" || fail "compose config invalid"

step "Start postgres / redis / rabbitmq (waits for healthchecks)"
docker compose up -d --wait postgres redis rabbitmq && pass "all three healthy" || { fail "infra did not become healthy"; abort "stopping: nothing below is meaningful without the infrastructure"; }

step "Postgres roles (least privilege)"
psql_su() { docker compose exec -T postgres psql -U postgres -d yalli -tA -c "$1"; }
[ "$(psql_su "SELECT rolsuper FROM pg_roles WHERE rolname='yalli_app'")" = "f" ] && pass "yalli_app is not superuser" || fail "yalli_app role wrong/missing"
[ "$(psql_su "SELECT rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='yalli_app'")" = "f" ] && pass "yalli_app cannot create DB/roles" || fail "yalli_app too powerful"
[ "$(psql_su "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='yalli'")" = "yalli_migrator" ] && pass "database owned by yalli_migrator" || fail "database owner wrong"

step "Apply migrations (DDL role)"
docker compose --profile tools build migrate || { fail "migrate image build failed"; abort "stopping: cannot build the migration image"; }
docker compose --profile tools run --rm -T migrate && pass "prisma migrate deploy" || { fail "migration failed"; abort "stopping: schema is not applied"; }

step "Seed roles and permissions (runtime DML-only role)"
docker compose --profile tools build seed || { fail "seed image build failed"; abort "stopping: cannot build the seed image"; }
docker compose --profile tools run --rm -T seed && pass "npm run seed (node dist/cli/seed.js)" || { fail "seed failed"; abort "stopping: roles are not seeded"; }
PSQL_SU() { docker compose exec -T postgres psql -U postgres -d yalli -tA -c "$1"; }
[ "$(PSQL_SU "SELECT count(*) FROM roles")" = "8" ] && pass "8 roles" || fail "roles count wrong"
[ "$(PSQL_SU "SELECT count(*) FROM permissions")" = "24" ] && pass "24 permissions" || fail "permissions count wrong"
[ "$(PSQL_SU "SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='CUSTOMER'")" = "0" ] && pass "CUSTOMER has no admin permissions" || fail "CUSTOMER has permissions"
[ "$(PSQL_SU "SELECT count(*) FROM warehouses WHERE is_default")" = "1" ] && pass "default warehouse seeded" || fail "default warehouse missing"
[ "$(PSQL_SU "SELECT count(*) FROM pg_extension WHERE extname='pg_trgm'")" = "1" ] && pass "pg_trgm search extension installed" || fail "pg_trgm missing"

step "Runtime role cannot tamper with the audit log"
APP="docker compose exec -T -e PGPASSWORD=$POSTGRES_APP_PASSWORD postgres psql -h localhost -U yalli_app -d yalli -tA"
$APP -c "INSERT INTO audit_logs(id,actor_type,action,outcome) VALUES (gen_random_uuid(),'SYSTEM','DOCKER_VERIFY','SUCCESS')" >/dev/null 2>&1 && pass "app can INSERT audit row" || fail "app cannot insert"
expect_denied "app cannot UPDATE audit_logs" "UPDATE audit_logs SET action='x'" "permission denied"
expect_denied "app cannot DELETE audit_logs" "DELETE FROM audit_logs" "permission denied"
expect_denied "app cannot run DDL" "CREATE TABLE evil(x int)" "permission denied"
expect_denied "bad audit outcome rejected by CHECK" "INSERT INTO audit_logs(id,actor_type,action,outcome) VALUES (gen_random_uuid(),'SYSTEM','X','NOPE')" "check constraint"

step "Build and start the app container (hardened: non-root, read-only fs, caps dropped)"
docker compose --profile app up -d --build --wait app && pass "app container healthy" || { fail "app container not healthy"; docker compose logs --tail 30 app; abort "stopping: app is not running"; }
UID_IN_CONTAINER=$(docker compose exec -T app id -u 2>/dev/null || true)
[ -n "$UID_IN_CONTAINER" ] && [ "$UID_IN_CONTAINER" != "0" ] && pass "app runs as non-root (uid $UID_IN_CONTAINER)" || fail "app root/unknown (uid '$UID_IN_CONTAINER')"

step "HTTP checks"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code http://127.0.0.1:3000/health/live)" = "200" ] && pass "GET /health/live -> 200" || fail "liveness failed"
[ "$(code http://127.0.0.1:3000/health/ready)" = "200" ] && pass "GET /health/ready -> 200 (db + redis reachable)" || fail "readiness failed"
H=$(curl -s -D - -o /dev/null http://127.0.0.1:3000/health/live)
[ -n "$H" ] || fail "no HTTP response to inspect headers"
if [ -n "$H" ]; then echo "$H" | grep -qi '^x-powered-by' && fail "x-powered-by exposed" || pass "x-powered-by hidden"; fi
echo "$H" | grep -qi "content-security-policy: default-src 'none'" && pass "CSP present" || fail "CSP missing"
BODY=$(curl -s http://127.0.0.1:3000/api/v1/nope)
echo "$BODY" | grep -q '"code":"NOT_FOUND"' && ! echo "$BODY" | grep -qi 'stack\|Cannot GET' && pass "404 uses safe error envelope" || fail "404 envelope wrong: $BODY"

step "Authentication smoke test through the real container (register -> verify -> login -> me -> logout)"
API=http://127.0.0.1:3000/api/v1
EMAIL="smoke.$(date +%s)@example.com"; PW='Tr0ub4dor&3-horse-staple'
REG=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"firstName\":\"Smoke\",\"lastName\":\"Test\",\"email\":\"$EMAIL\",\"phone\":\"+919876543210\",\"password\":\"$PW\",\"acceptPrivacyPolicy\":true}")
[ "$REG" = "202" ] && pass "register -> 202" || fail "register returned $REG"
sleep 1
TOKEN=$(docker compose logs --no-log-prefix app 2>&1 | grep -o 'verify-email?token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
[ -n "$TOKEN" ] && pass "verification link delivered (dev console driver)" || fail "no verification link in the app log"
LOGIN_BODY="{\"email\":\"$EMAIL\",\"password\":\"$PW\"}"
PRE_STATUS=$(code -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$LOGIN_BODY")
[ "$PRE_STATUS" = "403" ] && pass "login blocked before email verification" || fail "unverified login returned '$PRE_STATUS' (expected 403)"
VERIFY_BODY="{\"token\":\"$TOKEN\"}"
VERIFY_STATUS=$(code -X POST "$API/auth/verify-email" -H 'Content-Type: application/json' -d "$VERIFY_BODY")
[ "$VERIFY_STATUS" = "200" ] && pass "verify-email -> 200" || fail "verify-email returned '$VERIFY_STATUS' (expected 200)"
LOGIN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$LOGIN_BODY")
ACCESS=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
[ -n "$ACCESS" ] && pass "login -> access token" || fail "login failed: $LOGIN"
echo "$LOGIN" | grep -q 'passwordHash\|argon2' && fail "login response leaks credential material" || pass "login response has no credential material"
[ "$(code "$API/me" -H "Authorization: Bearer $ACCESS")" = "200" ] && pass "GET /me with token -> 200" || fail "/me with token failed"
[ "$(code "$API/me")" = "401" ] && pass "GET /me without token -> 401" || fail "/me without token not 401"
[ "$(code "$API/admin/roles" -H "Authorization: Bearer $ACCESS")" = "403" ] && pass "customer is forbidden on admin routes -> 403" || fail "customer reached admin route"
[ "$(code -X POST "$API/auth/logout" -H "Authorization: Bearer $ACCESS")" = "200" ] && pass "logout -> 200" || fail "logout failed"
[ "$(code "$API/me" -H "Authorization: Bearer $ACCESS")" = "401" ] && pass "revoked token rejected immediately" || fail "revoked token still accepted"
curl -s http://127.0.0.1:3000/.well-known/jwks.json | grep -q '"kty":"OKP"' && pass "JWKS published (no private key)" || fail "JWKS missing"
curl -s http://127.0.0.1:3000/.well-known/jwks.json | grep -q '"d":' && fail "JWKS exposes a private key" || pass "JWKS contains no private component"
[ "$(code http://127.0.0.1:3000/docs)" = "404" ] && pass "Swagger UI disabled in the container" || fail "Swagger UI reachable"

step "Commerce smoke test (catalogue -> search -> guest cart with server-side pricing)"
SUFFIX=$(date +%s)
SMOKE_SQL="WITH p AS (INSERT INTO products (id, slug, name, status, published_at, updated_at) VALUES (gen_random_uuid(), 'smoke-momos-maker-$SUFFIX', 'Smoke Momos Maker $SUFFIX', 'PUBLISHED', now(), now()) RETURNING id),
v AS (INSERT INTO product_variants (id, product_id, sku, price_minor, sale_price_minor, updated_at) SELECT gen_random_uuid(), p.id, 'SMOKE-$SUFFIX', 59000, 49000, now() FROM p RETURNING id)
INSERT INTO inventory (id, variant_id, warehouse_id, on_hand, updated_at) SELECT gen_random_uuid(), v.id, w.id, 5, now() FROM v, warehouses w WHERE w.is_default RETURNING variant_id"
VARIANT=$($APP -c "$SMOKE_SQL" 2>/dev/null | head -1 | tr -d '[:space:]')
[ -n "$VARIANT" ] && pass "product inserted with the runtime role" || fail "could not insert smoke product"
LISTING=$(curl -s "$API/catalog/products?q=smoke%20momos%20$SUFFIX")
echo "$LISTING" | grep -q "smoke-momos-maker-$SUFFIX" && pass "full-text search finds the product" || fail "search did not find the product: $LISTING"
echo "$LISTING" | grep -q '"amountMinor":49000' && echo "$LISTING" | grep -q '"compareAtMinor":59000' && pass "listing shows sale price with struck-through price" || fail "listing price wrong: $LISTING"
CART=$(curl -s -X POST "$API/cart/items" -H 'Content-Type: application/json' -d "{\"variantId\":\"$VARIANT\",\"quantity\":2}")
echo "$CART" | grep -q '"cartToken":"' && pass "guest cart created with a token" || fail "no guest cart token: $CART"
echo "$CART" | grep -q '"totalMinor":98000' && pass "cart total computed server-side (2 x 490.00)" || fail "cart total wrong: $CART"
OVER=$(code -X POST "$API/cart/items" -H 'Content-Type: application/json' -d "{\"variantId\":\"$VARIANT\",\"quantity\":6}")
[ "$OVER" = "409" ] && pass "cannot add more than the stock on hand" || fail "over-stock add returned '$OVER' (expected 409)"
PRICED=$(code -X POST "$API/cart/items" -H 'Content-Type: application/json' -d "{\"variantId\":\"$VARIANT\",\"quantity\":1,\"unitPriceMinor\":1}")
[ "$PRICED" = "400" ] && pass "client-supplied prices are rejected" || fail "client price accepted ('$PRICED')"

step "Checkout and event pipeline through the real container (address -> cart -> order -> outbox -> RabbitMQ)"
LOGIN2=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$LOGIN_BODY")
ACCESS2=$(echo "$LOGIN2" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
AUTHH="Authorization: Bearer $ACCESS2"
[ -n "$ACCESS2" ] && pass "signed in again" || fail "second login failed: $LOGIN2"
ADDR=$(curl -s -X POST "$API/me/addresses" -H "$AUTHH" -H 'Content-Type: application/json' -d '{"fullName":"Smoke Test","phone":"98765 43210","line1":"1 Test Street","city":"Madurai","state":"Tamil Nadu","postalCode":"625002"}')
ADDR_ID=$(echo "$ADDR" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$ADDR_ID" ] && pass "address saved" || fail "address not saved: $ADDR"
ADDRESP=$(curl -s -w '\n%{http_code}' -X POST "$API/cart/items" -H "$AUTHH" -H 'Content-Type: application/json' -d "{\"variantId\":\"$VARIANT\",\"quantity\":1}")
ADDCODE=$(echo "$ADDRESP" | tail -1)
[ "$ADDCODE" = "201" ] && pass "item added to the signed-in cart" || fail "add to cart returned '$ADDCODE' (variant '$VARIANT'): $ADDRESP"
NOKEY=$(code -X POST "$API/checkout/orders" -H "$AUTHH" -H 'Content-Type: application/json' -d "{\"addressId\":\"$ADDR_ID\"}")
[ "$NOKEY" = "400" ] && pass "checkout refuses a request without an Idempotency-Key" || fail "checkout without key returned '$NOKEY'"
IDEM="smoke-$SUFFIX-order"
ORDER=$(curl -s -X POST "$API/checkout/orders" -H "$AUTHH" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' -d "{\"addressId\":\"$ADDR_ID\"}")
ORDER_ID=$(echo "$ORDER" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$ORDER" | grep -q '"status":"INVENTORY_RESERVED"' && pass "order created and stock reserved" || fail "order not created: $ORDER"
echo "$ORDER" | grep -q '"totalMinor":49000' && pass "order total computed server-side (sale price 490.00)" || fail "order total wrong: $ORDER"
REPLAY=$(curl -s -X POST "$API/checkout/orders" -H "$AUTHH" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' -d "{\"addressId\":\"$ADDR_ID\"}")
[ "$(echo "$REPLAY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)" = "$ORDER_ID" ] && pass "retry with the same Idempotency-Key returns the same order" || fail "idempotent replay created a different order"
[ "$($APP -c "SELECT count(*) FROM orders WHERE id='$ORDER_ID'")" = "1" ] && pass "exactly one order stored" || fail "order count wrong"
[ "$($APP -c "SELECT reserved FROM inventory WHERE variant_id='$VARIANT'")" = "1" ] && pass "stock reserved exactly once" || fail "reserved stock wrong"
[ "$(code -X POST "$API/webhooks/razorpay" -H 'Content-Type: application/json' -d '{"event":"payment.captured"}')" = "401" ] && pass "unsigned payment webhook rejected (401)" || fail "unsigned webhook was not rejected"
[ "$(code -X POST "$API/webhooks/razorpay" -H 'Content-Type: application/json' -H "x-razorpay-signature: $(printf '0%.0s' $(seq 1 64))" -d '{"event":"payment.captured"}')" = "401" ] && pass "forged webhook signature rejected (401)" || fail "forged webhook was not rejected"
[ "$(code "$API/orders/$ORDER_ID" -H 'Content-Type: application/json')" = "401" ] && pass "orders require authentication" || fail "order readable without a token"

# The outbox relay runs inside the app container and publishes to the real broker.
PUBLISHED=0
for i in $(seq 1 20); do
  [ "$($APP -c "SELECT count(*) FROM outbox_events WHERE aggregate_id='$ORDER_ID' AND event_type='order.created' AND published_at IS NOT NULL")" = "1" ] && PUBLISHED=1 && break
  sleep 1
done
[ "$PUBLISHED" = "1" ] && pass "outbox event 'order.created' published by the relay" || fail "outbox event was not published within 20s (is RabbitMQ reachable from the app?)"
RMQ="curl -s -u $RABBITMQ_USER:$RABBITMQ_PASSWORD http://127.0.0.1:15672/api"
$RMQ/exchanges/%2F/yalli.events 2>/dev/null | grep -q '"type":"topic"' && pass "RabbitMQ exchange yalli.events (topic) exists" || fail "RabbitMQ exchange yalli.events missing"
QUEUES=$($RMQ/queues/%2F 2>/dev/null)
echo "$QUEUES" | grep -q '"name":"yalli.notifications"' && pass "consumer queue yalli.notifications declared" || fail "consumer queue missing"
echo "$QUEUES" | grep -q '"name":"yalli.notifications.dlq"' && pass "dead-letter queue yalli.notifications.dlq declared" || fail "DLQ missing"
echo "$QUEUES" | grep -q '"name":"yalli.notifications.retry"' && pass "retry queue yalli.notifications.retry declared" || fail "retry queue missing"
echo "$QUEUES" | grep -q '"type":"quorum"' && pass "queues are durable quorum queues" || fail "queues are not quorum queues"
# 'order.created' has no notification consumer by design, so drive an event that does: cancelling the unpaid order
# emits 'order.cancelled' (outbox -> relay -> RabbitMQ -> notifications queue -> consumer -> processed_messages).
CANCEL=$(code -X POST "$API/orders/$ORDER_ID/cancel" -H "$AUTHH" -H 'Content-Type: application/json' -d '{}')
[ "$CANCEL" = "200" ] && pass "unpaid order cancelled (emits order.cancelled)" || fail "order cancel returned '$CANCEL'"
CONSUMED=0
for i in $(seq 1 20); do
  [ "$($APP -c "SELECT count(*) FROM processed_messages WHERE consumer='notifications'")" -ge 1 ] && CONSUMED=1 && break
  sleep 1
done
[ "$CONSUMED" = "1" ] && pass "the consumer received and recorded an event (broker round trip works)" || fail "no event consumed within 20s"
[ "$($APP -c "UPDATE orders SET status='PAID' WHERE id='$ORDER_ID'" 2>&1 | grep -c 'paid_at\|violates')" -ge 1 ] && pass "database refuses PAID without paid_at" || fail "DB allowed an inconsistent PAID order"

step "Phase 6 database guarantees (shipping, reviews, reports)"
expect_denied "negative shipping fee rejected by CHECK" "INSERT INTO shipping_methods (id, code, name, base_minor, eta_min_days, eta_max_days, states, updated_at) VALUES (gen_random_uuid(), 'NEGFEE', 'Neg', -1, 1, 2, '{}', now())" "shipping_methods_money_chk"
expect_denied "inverted delivery ETA rejected by CHECK" "INSERT INTO shipping_methods (id, code, name, base_minor, eta_min_days, eta_max_days, states, updated_at) VALUES (gen_random_uuid(), 'BADETA', 'Bad', 100, 9, 2, '{}', now())" "shipping_methods_eta_chk"
expect_denied "a delivery fee without a recorded method is rejected" "UPDATE orders SET shipping_minor = 5000, total_minor = total_minor + 5000 WHERE id = '$ORDER_ID'" "orders_shipping_method_chk"
expect_denied "tracking history cannot be edited" "UPDATE shipment_events SET note = 'x'" "immutable|permission denied|not allowed|forbidden"
expect_denied "review rating outside 1-5 rejected" "INSERT INTO product_reviews (id, product_id, user_id, rating, body, updated_at) SELECT gen_random_uuid(), p.id, u.id, 9, 'a long enough review body', now() FROM products p, users u LIMIT 1" "product_reviews_rating_chk"
[ "$($APP -c "SELECT count(*) FROM pg_indexes WHERE indexname IN ('orders_paid_at_idx','refunds_processed_at_idx')")" = "2" ] && pass "report indexes present" || fail "report indexes missing"

step "Phase 7 hardening (reporting role, key material, runtime posture)"
REP="docker compose exec -T -e PGPASSWORD=$POSTGRES_REPORTING_PASSWORD postgres psql -h localhost -U yalli_reporting -d yalli -tA"
[ "$($REP -c "SELECT count(*) >= 0 FROM orders" 2>&1)" = "t" ] && pass "reporting role can aggregate orders" || fail "reporting role cannot read the report columns"
for t in "SELECT contact_email FROM orders" "SELECT * FROM orders" "SELECT password_hash FROM users" "SELECT * FROM audit_logs" "SELECT * FROM mfa_methods"; do
  expect_denied "reporting role denied: $t" "$t" "permission denied" "$REP"
done
expect_denied "reporting role cannot write" "UPDATE orders SET status = status" "permission denied|read-only" "$REP"
# Logs are JSON; the ReportingDb banner says "Reports use the read-only reporting role". The app
# only prints it when REPORTING_DATABASE_URL is set, so its presence proves the role is in use.
# Capture the stream first: grep -q exits on the first match, the log streamer then dies with
# SIGPIPE, and under `set -o pipefail` that would read as a failed pipeline even on a true match.
APP_LOGS=$(docker compose --profile app logs app 2>&1 || true)
grep -q "Reports use the read-only reporting role" <<< "$APP_LOGS" && pass "app container reports through the reporting role" || fail "app container is not using REPORTING_DATABASE_URL"
[ "$(docker compose --profile app exec -T app printenv MFA_ENCRYPTION_KEY_ID 2>/dev/null | tr -d '[:space:]')" != "" ] && pass "MFA key id is set (rotation is traceable)" || fail "MFA_ENCRYPTION_KEY_ID missing"
docker compose --profile app exec -T app sh -c "awk '\$2==\"/\" {print \$4}' /proc/mounts" 2>/dev/null | grep -q '^ro' && pass "application root filesystem is mounted read-only" || fail "application root filesystem is writable"
docker compose --profile app exec -T app node dist/cli/rotate-mfa-key.js --help >/dev/null 2>&1 && pass "rotate-mfa-key command ships in the image" || fail "rotate-mfa-key command missing from the image"

step "Summary"
if [ "$FAILED" = 0 ]; then printf '\033[32mAll Docker checks passed.\033[0m\n'; else printf '\033[31mSome checks failed - see FAIL lines above.\033[0m\n'; fi

if [ "${1:-}" = "--down" ]; then docker compose --profile app --profile tools down -v; fi
exit "$FAILED"
