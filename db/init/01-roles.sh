#!/bin/sh
# Runs once on first start of the Postgres container.
# placement_owner (bootstrap superuser) is used ONLY for migrations.
# placement_app is what the API connects as: not a superuser, no BYPASSRLS, not the table owner,
# so every row-level-security policy applies to it.
set -e

psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE placement_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE placement TO placement_app;
GRANT USAGE ON SCHEMA public TO placement_app;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
EOSQL
