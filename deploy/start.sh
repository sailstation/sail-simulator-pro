#!/bin/bash
# Lançador do app (transição do ADR-0004): roda o backend nativo da release (server/main.mjs)
# quando ele existe; senão, cai para o adaptador legado serve.mjs (releases antigas e rollback).
# Variáveis: SAIL_APP (release atual, via unit sail@), PORT/DATABASE_URL ou SAIL_PORT/SAIL_DB (env do ambiente).
set -euo pipefail
APP=$(readlink -f "${SAIL_APP:?defina SAIL_APP}")
if [ -f "$APP/server/main.mjs" ]; then
  exec /opt/node/bin/node "$APP/server/main.mjs"
fi
exec /opt/node/bin/node /opt/sail/bin/serve.mjs
