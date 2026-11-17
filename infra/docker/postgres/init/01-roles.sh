#!/usr/bin/env bash
# Runs once on first container start. Separates DDL (migrator) from DML (app) credentials.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v mig_pw="$POSTGRES_MIGRATOR_PASSWORD" -v app_pw="$POSTGRES_APP_PASSWORD" \
  -v rep_pw="$POSTGRES_REPORTING_PASSWORD" <<'SQL'
CREATE ROLE yalli_migrator LOGIN PASSWORD :'mig_pw';
CREATE ROLE yalli_app      LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- Read-only reports: column-level SELECT granted by a migration; nothing is granted here on purpose.
CREATE ROLE yalli_reporting LOGIN PASSWORD :'rep_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;

ALTER DATABASE yalli OWNER TO yalli_migrator;
REVOKE ALL ON DATABASE yalli FROM PUBLIC;
GRANT CONNECT ON DATABASE yalli TO yalli_app, yalli_reporting;

ALTER SCHEMA public OWNER TO yalli_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO yalli_app;

-- Tables/sequences created later by the migrator are usable (DML only) by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE yalli_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yalli_app;
ALTER DEFAULT PRIVILEGES FOR ROLE yalli_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO yalli_app;
SQL
