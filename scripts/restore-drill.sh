#!/bin/sh
# Monthly restore drill: restore a backup into a SEPARATE database (placement_restore_drill), count rows, then drop it.
# Afterwards record the result in the portal: Super Admin > System & keys > Monthly restore drill.
set -e
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE}"
FILE="${1:?Usage: restore-drill.sh backups/placement-YYYYMMDD-HHMMSS.dump.enc}"
docker compose exec -T postgres psql -U placement_owner -d postgres -c "DROP DATABASE IF EXISTS placement_restore_drill" -c "CREATE DATABASE placement_restore_drill"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" \
  | docker compose exec -T postgres pg_restore -U placement_owner -d placement_restore_drill --no-owner
docker compose exec -T postgres psql -U placement_owner -d placement_restore_drill -c "SELECT (SELECT count(*) FROM student) AS students, (SELECT count(*) FROM offer) AS offers, (SELECT count(*) FROM audit_log) AS audit_rows"
docker compose exec -T postgres psql -U placement_owner -d postgres -c "DROP DATABASE placement_restore_drill"
echo "Drill finished. Record it in the portal."
