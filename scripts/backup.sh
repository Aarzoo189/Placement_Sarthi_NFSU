#!/bin/sh
# Nightly encrypted backup: pg_dump (custom format) -> AES-256 (openssl) -> backups/. Keeps 30 days.
# Needs: docker compose running the postgres service, and BACKUP_PASSPHRASE in the environment (keep it in your secret store).
# For point-in-time recovery also enable WAL archiving (see docs/ARCHITECTURE.md, "Backups").
set -e
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE (not stored in the repo)}"
DIR="$(dirname "$0")/../backups"; mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/placement-$STAMP.dump.enc"
docker compose exec -T postgres pg_dump -U placement_owner -d placement -Fc \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT"
echo "Backup written: $OUT"
find "$DIR" -name 'placement-*.dump.enc' -mtime +30 -print -delete
