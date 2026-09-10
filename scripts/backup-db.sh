#!/bin/bash
# ── TaxPro database + storage backup ──
# Usage: DATABASE_URL_MIGRATIONS=postgres://... bash scripts/backup-db.sh [out-dir]
# Produces a timestamped pg_dump (custom format) plus a storage tarball.
# Schedule via cron/systemd for paid pilots; verify restores quarterly.
# Retention: keeps the 14 most recent backups per type in the out dir.

set -euo pipefail

OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

if [ -z "${DATABASE_URL_MIGRATIONS:-}" ]; then
  echo "[backup] DATABASE_URL_MIGRATIONS is not set — refusing to guess." >&2
  exit 1
fi

DUMP="$OUT_DIR/taxpro-$STAMP.dump"
echo "[backup] Dumping database → $DUMP"
pg_dump --format=custom --file="$DUMP" "$DATABASE_URL_MIGRATIONS"
echo "[backup] Database dump complete ($(du -h "$DUMP" | cut -f1))"

STORAGE_DIR="${TAXPRO_STORAGE_DIR:-./storage}"
if [ -d "$STORAGE_DIR" ]; then
  TAR="$OUT_DIR/taxpro-storage-$STAMP.tar.gz"
  echo "[backup] Archiving storage ($STORAGE_DIR) → $TAR"
  tar -czf "$TAR" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
  echo "[backup] Storage archive complete ($(du -h "$TAR" | cut -f1))"
else
  echo "[backup] No local storage dir ($STORAGE_DIR) — skipping storage archive."
fi

# Retention: 14 most recent of each type.
ls -1t "$OUT_DIR"/taxpro-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$OUT_DIR"/taxpro-storage-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "[backup] Done. Restore test: pg_restore --dbname=<empty-db> $DUMP"
