#!/usr/bin/env bash
set -euo pipefail

conversa_source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$conversa_source_dir"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Primero instala Docker Engine y el plugin Compose para el sistema de la VM.' >&2
  printf '%s\n' 'Consulta PUBLICAR_GOOGLE.md. Este script no cambia el sistema ni instala paquetes.' >&2
  exit 1
fi

docker compose version >/dev/null
for conversa_required_file in dist/index.html Caddyfile.vm compose.vm.yaml backend/server.mjs backend/Dockerfile; do
  if [[ ! -f "$conversa_required_file" ]]; then
    printf 'Falta el archivo: %s\n' "$conversa_required_file" >&2
    exit 1
  fi
done

printf '%s\n' 'Destino: esta VM. Dominio: cc.chatgo.ia.bo. Puertos necesarios: TCP 80 y 443.'
printf '%s\n' 'Se publicará Conversa con acceso por usuario y guardado en servidor. Instagram requiere configuración adicional; recepción solamente.'

docker compose -f compose.vm.yaml config --quiet
docker compose -f compose.vm.yaml build api
docker compose -f compose.vm.yaml run --rm --no-deps web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f compose.vm.yaml up -d --force-recreate
docker compose -f compose.vm.yaml ps

printf '%s\n' 'Contenedor iniciado. Revisa DNS, logs y HTTPS antes de dar la publicación por terminada.'
printf '%s\n' 'Logs: docker compose -f compose.vm.yaml logs --tail=80 web'
