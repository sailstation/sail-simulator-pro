#!/bin/bash
# Sobe um cluster PostgreSQL nativo e temporário (sem Docker nem contêiner), roda os testes
# de server/ contra ele com cobertura e derruba tudo ao final.
# Uso: scripts/pg-test.sh   (a partir de qualquer diretório; exige PostgreSQL em /usr/lib/postgresql)
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
[ -n "${BIN:-}" ] || { echo "PostgreSQL não encontrado em /usr/lib/postgresql/*/bin" >&2; exit 1; }
DIR=$(mktemp -d /tmp/sail-pgtest.XXXXXX)
cleanup() {
  "$BIN/pg_ctl" -D "$DIR/data" -m fast -w stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
"$BIN/initdb" -D "$DIR/data" -A trust -E UTF8 --no-sync >/dev/null
"$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/postgres.log" -w \
  -o "-k $DIR -p 54329 -c listen_addresses='' -c fsync=off" start >/dev/null
# Socket Unix com caminho percent-encoded; a porta só nomeia o arquivo do socket (diretório é único).
export DATABASE_URL="postgresql://$(printf '%s' "$DIR" | sed 's|/|%2F|g'):54329/postgres"
node --test \
  --experimental-test-coverage \
  --test-coverage-include='server/*.mjs' --test-coverage-exclude='server/*.test.mjs' \
  --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 \
  server/*.test.mjs
