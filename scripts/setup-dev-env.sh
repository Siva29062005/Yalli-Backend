#!/usr/bin/env bash
# Creates .env with random development secrets, or TOPS UP an existing one with any variable it is missing.
# Existing values are never overwritten, so it is safe to run again after pulling new code.
set -euo pipefail
cd "$(dirname "$0")/.."

rand() { openssl rand -hex 24; }

if [ ! -e .env ]; then
  SU=$(rand); MIG=$(rand); APP=$(rand); REP=$(rand); RED=$(rand); MQ=$(rand)
  sed \
    -e "s/^POSTGRES_SUPERUSER_PASSWORD=.*/POSTGRES_SUPERUSER_PASSWORD=$SU/" \
    -e "s/^POSTGRES_MIGRATOR_PASSWORD=.*/POSTGRES_MIGRATOR_PASSWORD=$MIG/" \
    -e "s/^POSTGRES_APP_PASSWORD=.*/POSTGRES_APP_PASSWORD=$APP/" \
    -e "s/^POSTGRES_REPORTING_PASSWORD=.*/POSTGRES_REPORTING_PASSWORD=$REP/" \
    -e "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$RED/" \
    -e "s/^RABBITMQ_PASSWORD=.*/RABBITMQ_PASSWORD=$MQ/" \
    -e "s/__POSTGRES_APP_PASSWORD__/$APP/" \
    -e "s/__POSTGRES_MIGRATOR_PASSWORD__/$MIG/" \
    -e "s/__POSTGRES_REPORTING_PASSWORD__/$REP/" \
    -e "s/__REDIS_PASSWORD__/$RED/" \
    -e "s/__RABBITMQ_PASSWORD__/$MQ/" \
    .env.example > .env
  chmod 600 .env
  echo "Created .env (mode 600) with random development passwords."
fi

# ensure VAR VALUE: append when missing; replace only a "__generated__" placeholder; otherwise leave alone.
ensure() {
  local key="$1" value="$2" current
  if ! grep -q "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >> .env
    echo "added   $key"
  else
    current=$(grep "^${key}=" .env | head -1 | cut -d= -f2-)
    if [ "$current" = "__generated__" ]; then
      awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
      echo "filled  $key"
    fi
  fi
}

# Key material is generated with Node (always present for this project) so it does not depend on the system openssl build.
JWT_KEY=$(node -e "const c=require('node:crypto');process.stdout.write(Buffer.from(c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))")
MFA_KEY=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")

REPORTING_PW=$(rand)
ensure POSTGRES_REPORTING_PASSWORD "$REPORTING_PW"
ensure REPORTING_DATABASE_URL "postgresql://yalli_reporting:${REPORTING_PW}@localhost:5432/yalli"
ensure JWT_KEY_ID dev-1
ensure JWT_PRIVATE_KEY_B64 "$JWT_KEY"
ensure JWT_RETIRED_PUBLIC_KEYS_JSON '{}'
ensure MFA_ENCRYPTION_KEY_B64 "$MFA_KEY"
ensure FRONTEND_SERVER_KEY "$(rand)"
ensure MFA_ENCRYPTION_KEY_ID k1
ensure COOKIE_SECURE false
ensure CAPTCHA_PROVIDER none
ensure HIBP_ENABLED false
ensure NOTIFICATIONS_DRIVER console
ensure FRONTEND_BASE_URL http://localhost:5173
ensure LOG_PRETTY true
echo ".env is up to date."
