#!/bin/bash
# Aplica a infraestrutura (deploy/) de um commit da main que já passou nos testes.
# Chamado pelo deploy.sh, como root. Uso: infra-apply.sh <commit> <tree-de-deploy/>
# Fluxo: extrai do Git -> valida -> faz backup -> instala -> verifica saúde -> confirma ou reverte.
set -uo pipefail
BASE=/opt/sail
SHA=$1 TREE=$2
STAGE=$BASE/infra/stage-$TREE
BACKUP=$BASE/infra/backup-$(date +%Y%m%d-%H%M%S).tar
GIT="git --git-dir=$BASE/repo.git"
export PATH=/opt/node/bin:$PATH
log() { echo "infra $TREE: $*"; }
fail() { log "FALHOU: $*"; echo "$TREE" > "$BASE/state/infra.failed"; exit 1; }

# 1. Extrai deploy/ direto do Git (nunca de um diretório onde testes rodaram).
rm -rf "$STAGE" && mkdir -p "$STAGE"
$GIT archive "$SHA" deploy | tar -x -C "$STAGE" || fail "não foi possível extrair deploy/"
SRC=$STAGE/deploy

# 2. Validação antes de tocar em qualquer coisa.
for f in deploy.sh install.sh infra-apply.sh; do bash -n "$SRC/$f" || fail "sintaxe inválida em $f"; done
node --check "$SRC/serve.mjs" || fail "serve.mjs inválido"
caddy validate --config "$SRC/caddy/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || fail "Caddyfile inválido"
units=$(mktemp -d); cp "$SRC/systemd/sail-deploy.service" "$SRC/systemd/sail-deploy.timer" "$units/"; cp "$SRC/systemd/sail@.service" "$units/sail@prod.service"
systemd-analyze verify "$units"/* >/dev/null 2>&1 || fail "units systemd inválidas"; rm -rf "$units"

# 3. Backup do que está instalado.
mkdir -p "$BASE/infra"
tar -cf "$BACKUP" -C / $(cd / && ls -d opt/sail/bin/serve.mjs opt/sail/bin/deploy.sh opt/sail/bin/infra-apply.sh opt/sail/bin/package.json \
  opt/sail/schema opt/sail/prod.env opt/sail/test.env etc/systemd/system/sail@.service etc/systemd/system/sail-deploy.service \
  etc/systemd/system/sail-deploy.timer etc/caddy/Caddyfile 2>/dev/null) || fail "backup falhou"

restore() {
  log "revertendo para $BACKUP"
  tar -xf "$BACKUP" -C /
  systemctl daemon-reload
  systemctl restart sail@prod sail@test
  systemctl reload-or-restart caddy
}

healthy() { # ambiente host porta-https porta-app
  # O teste pode estar rodando um PR quebrado de propósito: lá só se verifica que o Caddy atende com TLS válido.
  if [ "$1" = test ]; then curl -sS -m 5 -o /dev/null --resolve "$2:$3:127.0.0.1" "https://$2:$3/__deploy"; return; fi
  curl -fsS -m 5 -o /dev/null --resolve "$2:$3:127.0.0.1" "https://$2:$3/__deploy" || return 1
  curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$4/" || return 1
  # A API precisa chegar ao banco: sala inexistente responde 404 (503 indica banco fora).
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
      -d '{"code":"AAAA222","token":"x"}' "http://127.0.0.1:$4/api/rooms/sync")" = 404 ]
}

# 4. Instala (sem disparar outro deploy).
if ! SAIL_SKIP_DEPLOY=1 "$SRC/install.sh"; then restore; fail "install.sh falhou"; fi

# 5. Verificação de saúde por até 60 s.
for i in $(seq 1 12); do
  if systemctl is-active -q sail@prod caddy postgresql \
     && healthy prod sail-pro.sailstation.com 443 9000 && healthy test sail-test.sailstation.com 8443 9001; then
    echo "$TREE" > "$BASE/state/infra.tree"
    ls -1t "$BASE"/infra/backup-*.tar 2>/dev/null | tail -n +6 | xargs -r rm -f
    rm -rf "$STAGE"
    log "aplicada com sucesso (commit $SHA)"
    exit 0
  fi
  sleep 5
done
restore
fail "verificação de saúde falhou após a instalação"
