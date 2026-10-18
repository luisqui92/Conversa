#!/usr/bin/env bash
set -euo pipefail
umask 077
# This config holds resource names and a fingerprint, never the key or access tokens.
config="${CONVERSA_BACKUP_CONFIG:-/etc/conversa-backup.conf}"
[[ -f "$config" && $(stat -c '%u:%a' "$config") == '0:600' ]] || { echo 'Se requiere configuración root:600.' >&2; exit 1; }
source "$config"
: "${CONVERSA_BACKUP_BUCKET:?}" "${CONVERSA_KEY_SECRET_VERSION:?}" "${CONVERSA_MASTER_KEY_SHA256:?}"
[[ "$CONVERSA_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || exit 1
command -v gcloud >/dev/null
install -d -m 0700 /var/lib/conversa-backup
exec 9>/var/lib/conversa-backup/lock
flock -n 9 || exit 0
api=conversa-demo-api-1
backup_id="$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')-$(cat /proc/sys/kernel/random/uuid)"
staging=$(mktemp -d /var/lib/conversa-backup/run.XXXXXX)
complete=0
cleanup() {
  if [[ $complete == 0 ]]; then docker exec "$api" node backend/offsite-backup.mjs failure "$backup_id" >/dev/null 2>&1 || true; fi
  docker exec "$api" node backend/offsite-backup.mjs remove "$backup_id" >/dev/null 2>&1 || true
  rm -rf -- "$staging"
}
trap cleanup EXIT
# No key leaves the running container. The snapshot contains only encrypted social tokens.
docker exec -e "CONVERSA_KEY_SECRET_VERSION=$CONVERSA_KEY_SECRET_VERSION" \
  -e "CONVERSA_MASTER_KEY_SHA256=$CONVERSA_MASTER_KEY_SHA256" \
  "$api" node backend/offsite-backup.mjs create "$backup_id"
docker cp "$api:/data/offsite-pending/$backup_id/database.sqlite" "$staging/database.sqlite"
docker cp "$api:/data/offsite-pending/$backup_id/manifest.json" "$staging/manifest.json"
base="gs://$CONVERSA_BACKUP_BUCKET/conversa/$backup_id"
gcloud storage cp --quiet --if-generation-match=0 "$staging/database.sqlite" "$base/database.sqlite"
# A manifest is the completion marker. Publish it only after the database upload succeeds.
gcloud storage cp --quiet --if-generation-match=0 "$staging/manifest.json" "$base/manifest.json"
docker exec "$api" node backend/offsite-backup.mjs success "$backup_id"
complete=1
printf 'Respaldo externo completado: %s\n' "$backup_id"
