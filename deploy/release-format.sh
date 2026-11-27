#!/bin/bash
# Reconhece o formato de uma release durante a transição para o backend nativo (ADR-0004).
# Uso:
#   release-format.sh <dir>          -> imprime "nativo" ou "legado"
#   release-format.sh --pronta <dir> -> exit 0 se a release tem o artefato executável do seu formato
# Nativo: backend em server/main.mjs com dependências travadas (package-lock.json, instaladas por
# npm ci no deploy). Legado: Worker empacotado por scripts/build-site.mjs em dist/server/index.js.
set -euo pipefail

formato() { # dir
  if [ -f "$1/server/main.mjs" ] && [ -f "$1/package-lock.json" ]; then
    echo nativo
  else
    echo legado
  fi
}

if [ "${1:-}" = --pronta ]; then
  dir=${2:?uso: release-format.sh --pronta <diretório-da-release>}
  case $(formato "$dir") in
    nativo) [ -f "$dir/server/main.mjs" ] ;;
    legado) [ -f "$dir/dist/server/index.js" ] ;;
  esac
else
  formato "${1:?uso: release-format.sh <diretório-da-release>}"
fi
