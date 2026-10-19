#!/usr/bin/env sh
# Full-stack Datran backup (see deploy/README.md "Backup"):
#   1. PostgreSQL     pg_dump -Fc                       -> $OUT/<stamp>/postgres.dump
#   2. app storage    tar of /data/app/storage          -> $OUT/<stamp>/app-storage.tar.gz
#   3. reactor        online consistent snapshot (POST /store/backup, incremental against the
#                     previous reactor backup)          -> $REACTOR_BACKUP_HOST_DIR/<stamp>/
#
# Order matters: the database is dumped FIRST, so every file it references existed before the reactor
# snapshot (files uploaded in between are harmless extras in the reactor backup).
#
# Usage (from the repo root):  deploy/backup.sh [OUT_DIR]
#   OUT_DIR                   default ./backups
#   REACTOR_BACKUP_HOST_DIR   host directory bind-mounted at /backups in the reactor container, where the
#                             reactor sets REACTOR_BACKUP_DIR=/backups (default $OUT_DIR/reactor)
#   REACTOR_FULL=1            force a full (non-incremental) reactor backup
#   COMPOSE                   override the compose command
#
# Restore: see deploy/README.md. Master keys (REACTOR_MASTER_KEY*) are NOT in any backup: keep them in
# your secret store; a restore of an encrypted store needs the same keys.
set -eu

OUT=${1:-./backups}
COMPOSE=${COMPOSE:-"docker compose -f deploy/docker-compose.yml --env-file deploy/.env"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
REACTOR_HOST_DIR=${REACTOR_BACKUP_HOST_DIR:-$OUT/reactor}
DEST="$OUT/$STAMP"
mkdir -p "$DEST" "$REACTOR_HOST_DIR"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# 1. PostgreSQL (custom format: compressed, restorable with pg_restore, consistent snapshot)
log "pg_dump -> $DEST/postgres.dump"
$COMPOSE exec -T postgres pg_dump -U datran -d datran -Fc > "$DEST/postgres.dump.tmp"
mv "$DEST/postgres.dump.tmp" "$DEST/postgres.dump"

# 2. app storage (local file storage of the app; empty when STORAGE_BACKEND=reactor)
log "app storage -> $DEST/app-storage.tar.gz"
$COMPOSE exec -T app sh -c 'cd /data/app && if [ -d storage ]; then tar -cf - storage; else tar -cf - --files-from /dev/null; fi' | gzip > "$DEST/app-storage.tar.gz.tmp"
mv "$DEST/app-storage.tar.gz.tmp" "$DEST/app-storage.tar.gz"

# 3. reactor: incremental against the newest complete reactor backup (has MANIFEST.json)
PREV=""
if [ "${REACTOR_FULL:-0}" != "1" ]; then
  for d in $(ls -1 "$REACTOR_HOST_DIR" 2>/dev/null | sort -r); do
    if [ -f "$REACTOR_HOST_DIR/$d/MANIFEST.json" ]; then PREV=$d; break; fi
  done
fi
if [ -n "$PREV" ]; then
  BODY=$(printf '{"dest":"%s","previous":"%s"}' "$STAMP" "$PREV")
  log "reactor online backup -> $REACTOR_HOST_DIR/$STAMP (incremental on $PREV)"
else
  BODY=$(printf '{"dest":"%s"}' "$STAMP")
  log "reactor online backup -> $REACTOR_HOST_DIR/$STAMP (full)"
fi
# runs inside the reactor container (curl + REACTOR_TOKEN are there; the API is never published)
$COMPOSE exec -T reactor sh -c 'curl -fsS --max-time 86400 -X POST \
  -H "x-reactor-token: $REACTOR_TOKEN" -H "content-type: application/json" \
  --data "$1" "http://127.0.0.1:${REACTOR_PORT:-3005}/store/backup"' sh "$BODY" > "$DEST/reactor-backup-report.json"
test -f "$REACTOR_HOST_DIR/$STAMP/MANIFEST.json" || { log "reactor backup has no MANIFEST.json"; exit 1; }
printf '%s\n' "$STAMP" > "$DEST/REACTOR_BACKUP"

( cd "$DEST" && sha256sum postgres.dump app-storage.tar.gz > SHA256SUMS )
log "done: $DEST (+ reactor backup $REACTOR_HOST_DIR/$STAMP)"
