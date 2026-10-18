#!/usr/bin/env bash
set -euo pipefail
umask 077
manifest_uri="${1:?Indica gs://BUCKET/conversa/ID/manifest.json}"
image="${2:-conversa-demo-api}"
[[ "$manifest_uri" =~ ^gs://[a-z0-9][a-z0-9._-]+/conversa/[a-z0-9-]{10,90}/manifest.json$ ]] || exit 1
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
# Use a recovery identity with read access to the bucket AND the specific secret.
# The scheduled backup identity must not have Secret Manager accessor permission.
gcloud storage cp --quiet "$manifest_uri" "$staging/manifest.json"
read -r secret_project secret_name secret_version < <(
  docker run --rm --network none --user root -v "$staging:/restore:ro" "$image" \
    node backend/offsite-backup.mjs secret-ref /restore/manifest.json
)
[[ -n "$secret_project" && -n "$secret_name" && "$secret_version" =~ ^[1-9][0-9]*$ ]] || exit 1
gcloud storage cp --quiet "${manifest_uri%manifest.json}database.sqlite" "$staging/database.sqlite"
gcloud secrets versions access "$secret_version" --project="$secret_project" \
  --secret="$secret_name" --out-file="$staging/master.key"
chmod 600 "$staging"/*
# Root here only reads a private, temporary host directory; there is no network or worker.
docker run --rm --network none --user root -v "$staging:/restore:ro" "$image" \
  node backend/offsite-backup.mjs verify /restore
printf '%s\n' 'Restauración comprobada en una copia aislada. No se inició la API ni se enviaron mensajes.'
